import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Injectable, Logger } from "@nestjs/common";
import { isUniqueViolation } from "../../infra/database/postgres-errors";
import { IntegrationEvent } from "../../shared/application/integration-event";
import { payloadHash } from "../../shared/application/payload-hash";
import { Money, MoneyProps } from "../../shared/domain/money";
import { newId } from "../../shared/infra/ids";
import { InboxMessage } from "../../shared/domain/inbox-message";
import { INBOX_PRIMARY_KEY, insertInboxMessage } from "../../shared/infra/inbox.sql";
import { insertOutboxEvents } from "../../shared/infra/outbox.sql";
import {
  idempotencyConflictsTotal,
  idempotentReplaysTotal,
  wagerProcessingDuration,
  wagerTransactionsTotal,
  walletConcurrencyConflictsTotal,
} from "../../shared/observability/metrics";
import {
  ConcurrentWalletUpdateError,
  WalletNotFoundError,
} from "../../wallet/application/wallet.errors";
import { InsufficientFundsError, Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import {
  findWalletById,
  insertLedgerEntry,
  updateWalletBalance,
} from "../../wallet/infra/wallet.sql";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import {
  claimDuePendingReference,
  findWagerTransactionByIdempotencyKey,
  findWagerTransactionByProviderReference,
  hasProcessedReversal,
  insertWagerTransaction,
  scheduleReferenceRetry,
  updateResolvedWagerTransaction,
} from "../infra/wager-transaction.sql";
import {
  DuplicateInboxMessageError,
  IdempotencyConflictError,
  UnsupportedTransactionKindError,
  WalletMismatchError,
} from "./wagering.errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "./wagering.events";

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export interface PendingReferencePolicy {
  /** Tentativas antes de recusar com REFERENCE_NOT_FOUND. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function pendingReferencePolicyFromEnv(): PendingReferencePolicy {
  return {
    maxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10),
    baseDelayMs: Number(process.env.PENDING_REFERENCE_BASE_DELAY_MS ?? 2_000),
    maxDelayMs: Number(process.env.PENDING_REFERENCE_MAX_DELAY_MS ?? 300_000),
  };
}

export type PendingReferenceOutcome = "resolved" | "waiting" | "expired";

export interface ProcessWagerInput {
  idempotencyKey: string;
  correlationId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerOptions {
  /** Presente quando a entrada vem da fila: gravado na mesma transação do efeito financeiro. */
  inbox?: InboxMessage;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);

  constructor(private readonly orm: MikroORM) {}

  async execute(
    input: ProcessWagerInput,
    options: ProcessWagerOptions = {},
  ): Promise<ProcessWagerResult> {
    const stopTimer = wagerProcessingDuration.startTimer();
    const context = {
      correlationId: input.correlationId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      walletId: input.walletId,
      kind: input.kind,
    };

    try {
      const result = await this.executeOnce(input, options);

      if (result.idempotentReplay) {
        idempotentReplaysTotal.inc();
      } else {
        wagerTransactionsTotal.inc({ kind: input.kind, status: result.status });
      }
      stopTimer({ outcome: result.idempotentReplay ? "replay" : result.status });

      this.logger.log("wager transaction handled", {
        ...context,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        idempotencyConflictsTotal.inc();
      }
      if (error instanceof ConcurrentWalletUpdateError) {
        walletConcurrencyConflictsTotal.inc();
      }
      stopTimer({ outcome: "error" });

      this.logger.warn("wager transaction failed", {
        ...context,
        errorCode: error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN",
      });
      throw error;
    }
  }

  private async executeOnce(
    input: ProcessWagerInput,
    options: ProcessWagerOptions,
  ): Promise<ProcessWagerResult> {
    if (!SUPPORTED_KINDS.has(input.kind)) {
      throw new UnsupportedTransactionKindError(input.kind);
    }
    const kind = input.kind as WagerTransactionKind;

    const money = Money.from(input.money);
    const hash = payloadHash(businessPayload(input));

    try {
      return await this.orm.em
        .fork()
        .transactional((em) => this.processTransaction(em, input, kind, money, hash, options));
    } catch (error) {
      if (options.inbox && isUniqueViolation(error, INBOX_PRIMARY_KEY)) {
        throw new DuplicateInboxMessageError(options.inbox.messageId);
      }
      if (
        isUniqueViolation(error, "wager_tx_idempotency_key_unique") ||
        isUniqueViolation(error, "wager_tx_provider_external_unique")
      ) {
        return this.replay(input.idempotencyKey, hash);
      }
      throw error;
    }
  }

  private async processTransaction(
    em: EntityManager,
    input: ProcessWagerInput,
    kind: WagerTransactionKind,
    money: Money,
    hash: string,
    options: ProcessWagerOptions,
  ): Promise<ProcessWagerResult> {
    const now = new Date();

    if (options.inbox) {
      options.inbox.markProcessed(now);
      await insertInboxMessage(em, options.inbox);
    }

    const wallet = await findWalletById(em, input.walletId, { forUpdate: true });
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    if (wallet.playerId !== input.playerId || wallet.currency !== money.currency) {
      throw new WalletMismatchError();
    }

    const transaction = WagerTransaction.create({
      id: newId(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: hash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });

    let reference: WagerTransaction | undefined;
    if (transaction.requiresReference()) {
      reference = await findWagerTransactionByProviderReference(
        em,
        transaction.providerId,
        transaction.referenceExternalTransactionId ?? "",
      );
      if (!reference) {
        transaction.markPendingReference(wallet.balance);
        await insertWagerTransaction(em, transaction);
        await insertOutboxEvents(
          em,
          buildEvents(transaction, wallet, undefined, input.correlationId, now),
        );
        return toResult(transaction, false);
      }
    }

    const previousVersion = wallet.version;
    const entry = await resolveAgainstWallet(em, wallet, transaction, reference, now);

    await insertWagerTransaction(em, transaction);
    if (entry) {
      await insertLedgerEntry(em, entry);
      await updateWalletBalance(em, wallet, previousVersion);
    }
    await insertOutboxEvents(em, buildEvents(transaction, wallet, entry, input.correlationId, now));

    return toResult(transaction, false);
  }

  /**
   * Reprocessa uma transação em PENDING_REFERENCE (usado pelo worker agendado).
   * Devolve undefined quando não há nenhuma pendente e vencida.
   */
  async retryPendingReference(
    policy: PendingReferencePolicy = pendingReferencePolicyFromEnv(),
    now: Date = new Date(),
  ): Promise<PendingReferenceOutcome | undefined> {
    return this.orm.em.fork().transactional(async (em) => {
      const claim = await claimDuePendingReference(em, now);
      if (!claim) {
        return undefined;
      }
      const { transaction } = claim;
      const wallet = await findWalletById(em, transaction.walletId, { forUpdate: true });
      if (!wallet) {
        throw new WalletNotFoundError();
      }

      const reference = await findWagerTransactionByProviderReference(
        em,
        transaction.providerId,
        transaction.referenceExternalTransactionId ?? "",
      );

      if (!reference) {
        const attempts = claim.attempts + 1;
        if (attempts < policy.maxAttempts) {
          const delay = Math.min(policy.baseDelayMs * 2 ** (attempts - 1), policy.maxDelayMs);
          await scheduleReferenceRetry(em, transaction.id, attempts, new Date(now.getTime() + delay));
          return "waiting";
        }
        transaction.reject("REFERENCE_NOT_FOUND", wallet.balance, now);
        await updateResolvedWagerTransaction(em, transaction);
        await insertOutboxEvents(em, buildEvents(transaction, wallet, undefined, transaction.id, now));
        wagerTransactionsTotal.inc({ kind: transaction.kind, status: transaction.status });
        return "expired";
      }

      const previousVersion = wallet.version;
      const entry = await resolveAgainstWallet(em, wallet, transaction, reference, now);
      await updateResolvedWagerTransaction(em, transaction);
      if (entry) {
        await insertLedgerEntry(em, entry);
        await updateWalletBalance(em, wallet, previousVersion);
      }
      await insertOutboxEvents(em, buildEvents(transaction, wallet, entry, transaction.id, now));
      wagerTransactionsTotal.inc({ kind: transaction.kind, status: transaction.status });
      return "resolved";
    });
  }

  private async replay(idempotencyKey: string, hash: string): Promise<ProcessWagerResult> {
    const existing = await findWagerTransactionByIdempotencyKey(this.orm.em.fork(), idempotencyKey);
    if (!existing || !existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError();
    }
    return toResult(existing, true);
  }
}

/**
 * Aplica a transação na carteira e define o status final.
 * Para REFUND e ROLLBACK, valida a referência antes (inclusive se ela já foi revertida).
 * Devolve o lançamento do extrato, ou undefined quando o saldo não muda.
 * Executado com a carteira travada, então a checagem de "já revertida" não tem corrida.
 */
async function resolveAgainstWallet(
  em: EntityManager,
  wallet: Wallet,
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  now: Date,
): Promise<WalletLedgerEntry | undefined> {
  if (reference) {
    const problem =
      transaction.referenceProblem(reference) ??
      ((await hasProcessedReversal(em, reference.id))
        ? "REFERENCE_ALREADY_REVERSED"
        : undefined);
    if (problem) {
      transaction.reject(problem, wallet.balance, now, reference.id);
      return undefined;
    }
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === undefined) {
    transaction.markProcessed(wallet.balance, now, reference?.id);
    return undefined;
  }

  const movement = {
    money: transaction.money,
    transactionId: transaction.id,
    entryId: newId(),
    at: now,
  };

  if (direction === LedgerDirection.Credit) {
    const entry = wallet.credit(movement);
    transaction.markProcessed(wallet.balance, now, reference?.id);
    return entry;
  }

  try {
    const entry = wallet.debit(movement);
    transaction.markProcessed(wallet.balance, now, reference?.id);
    return entry;
  } catch (error) {
    if (!(error instanceof InsufficientFundsError)) {
      throw error;
    }
    const code = reference ? "REVERSAL_INSUFFICIENT_FUNDS" : "INSUFFICIENT_FUNDS";
    transaction.reject(code, wallet.balance, now, reference?.id);
    return undefined;
  }
}

function businessPayload(input: ProcessWagerInput) {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
}

function toResult(transaction: WagerTransaction, idempotentReplay: boolean): ProcessWagerResult {
  const balance = transaction.observedBalance;
  if (!balance) {
    throw new Error(`transaction ${transaction.id} has no observed balance`);
  }
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}

function buildEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  correlationId: string,
  now: Date,
): IntegrationEvent<unknown>[] {
  const resultData = {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    balance: wallet.balance.toJSON(),
    failureCode: transaction.failureCode,
  };
  const base = { correlationId, causationId: transaction.id, occurredAt: now };

  if (transaction.status === WagerTransactionStatus.PendingReference) {
    return [
      new WagerTransactionPendingReference({
        ...base,
        eventId: newId(),
        aggregateId: transaction.id,
        data: resultData,
      }),
    ];
  }

  if (transaction.status === WagerTransactionStatus.Rejected) {
    return [
      new WagerTransactionRejected({ ...base, eventId: newId(), aggregateId: transaction.id, data: resultData }),
    ];
  }

  const events: IntegrationEvent<unknown>[] = [
    new WagerTransactionProcessed({ ...base, eventId: newId(), aggregateId: transaction.id, data: resultData }),
  ];
  if (!entry) {
    return events;
  }

  events.push(
    new WalletBalanceChanged({
      ...base,
      eventId: newId(),
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    }),
  );
  return events;
}