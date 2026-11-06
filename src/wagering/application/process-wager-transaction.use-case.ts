import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Injectable, Logger } from "@nestjs/common";
import { isUniqueViolation } from "../../infra/database/postgres-errors";
import { IntegrationEvent } from "../../shared/application/integration-event";
import { payloadHash } from "../../shared/application/payload-hash";
import { Money, MoneyProps } from "../../shared/domain/money";
import { newId } from "../../shared/infra/ids";
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
import { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
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
  findWagerTransactionByIdempotencyKey,
  insertWagerTransaction,
} from "../infra/wager-transaction.sql";
import {
  IdempotencyConflictError,
  UnsupportedTransactionKindError,
  WalletMismatchError,
} from "./wagering.errors";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "./wagering.events";

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
]);

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

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const stopTimer = wagerProcessingDuration.startTimer();
    const context = {
      correlationId: input.correlationId,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      walletId: input.walletId,
      kind: input.kind,
    };

    try {
      const result = await this.executeOnce(input);

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

  private async executeOnce(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    if (!SUPPORTED_KINDS.has(input.kind)) {
      throw new UnsupportedTransactionKindError(input.kind);
    }
    const kind = input.kind as WagerTransactionKind;

    const money = Money.from(input.money);
    const hash = payloadHash(businessPayload(input));

    try {
      return await this.orm.em
        .fork()
        .transactional((em) => this.processTransaction(em, input, kind, money, hash));
    } catch (error) {
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
  ): Promise<ProcessWagerResult> {
    const now = new Date();

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

    const previousVersion = wallet.version;
    const entry = applyToWallet(wallet, transaction, now);

    await insertWagerTransaction(em, transaction);
    if (entry) {
      await insertLedgerEntry(em, entry);
      await updateWalletBalance(em, wallet, previousVersion);
    }
    await insertOutboxEvents(em, buildEvents(transaction, wallet, entry, input.correlationId, now));

    return toResult(transaction, false);
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
 * Aplica a transação na carteira de acordo com o tipo e define o status final.
 * Devolve o lançamento do extrato, ou undefined quando o saldo não muda.
 */
function applyToWallet(
  wallet: Wallet,
  transaction: WagerTransaction,
  now: Date,
): WalletLedgerEntry | undefined {
  const movement = {
    money: transaction.money,
    transactionId: transaction.id,
    entryId: newId(),
    at: now,
  };

  switch (transaction.kind) {
    case WagerTransactionKind.Bet: {
      try {
        const entry = wallet.debit(movement);
        transaction.markProcessed(wallet.balance, now);
        return entry;
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) {
          throw error;
        }
        transaction.reject("INSUFFICIENT_FUNDS", wallet.balance, now);
        return undefined;
      }
    }
    case WagerTransactionKind.Win: {
      const entry = wallet.credit(movement);
      transaction.markProcessed(wallet.balance, now);
      return entry;
    }
    case WagerTransactionKind.Loss: {
      transaction.markProcessed(wallet.balance, now);
      return undefined;
    }
    default:
      throw new UnsupportedTransactionKindError(transaction.kind);
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