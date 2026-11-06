import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { newId } from "../../src/shared/infra/ids";
import { GetWagerTransactionUseCase } from "../../src/wagering/application/get-wager-transaction.use-case";
import {
  ProcessWagerInput,
  ProcessWagerTransactionUseCase,
} from "../../src/wagering/application/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { GetWalletUseCase } from "../../src/wallet/application/get-wallet.use-case";
import { Wallet } from "../../src/wallet/domain/wallet";
import { betInput, ledgerOf, reconstructBalance } from "./support/helpers";

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let getWallet: GetWalletUseCase;
let getTransaction: GetWagerTransactionUseCase;
let processWager: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  Logger.overrideLogger(["error"]);
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  getWallet = new GetWalletUseCase(orm);
  getTransaction = new GetWagerTransactionUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

function openWallet(amount = "100.00") {
  return createWallet.execute({ playerId: newId(), initialBalance: { amount, currency: "BRL" } });
}

/** Monta uma operação; o id externo é devolvido para servir de referência. */
function operation(
  wallet: Wallet,
  kind: string,
  amount: string,
  reference?: string,
  overrides: Partial<ProcessWagerInput> = {},
): ProcessWagerInput {
  const externalId = `${kind.toLowerCase()}-${newId()}`;
  return {
    ...betInput(wallet, externalId, amount),
    kind,
    referenceExternalTransactionId: reference,
    ...overrides,
  };
}

async function expectConsistent(walletId: string, balance: string) {
  const wallet = await getWallet.execute(walletId);
  const reconstructed = reconstructBalance(await ledgerOf(orm, walletId), wallet.currency);
  expect(reconstructed.equals(wallet.balance)).toBe(true);
  expect(wallet.balance.toString()).toBe(balance);
  return wallet;
}

describe("REFUND", () => {
  test("devolve a aposta, uma única vez", async () => {
    const wallet = await openWallet();
    const bet = operation(wallet, "BET", "30.00");
    await processWager.execute(bet);

    const refund = await processWager.execute(
      operation(wallet, "REFUND", "30.00", bet.externalTransactionId),
    );
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe("100.00");

    const second = await processWager.execute(
      operation(wallet, "REFUND", "30.00", bet.externalTransactionId),
    );
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

    const stored = await getTransaction.byId(refund.transactionId);
    const original = await getTransaction.byProviderReference("provider-a", bet.externalTransactionId);
    expect(stored.referenceTransactionId).toBe(original.id);

    const after = await expectConsistent(wallet.id, "100.00");
    expect(after.version).toBe(3);
  });

  test("dois REFUNDs diferentes da mesma aposta em paralelo: só um é aplicado", async () => {
    const wallet = await openWallet();
    const bet = operation(wallet, "BET", "40.00");
    await processWager.execute(bet);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        processWager.execute(operation(wallet, "REFUND", "40.00", bet.externalTransactionId)),
      ),
    );

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((result) => result.failureCode === "REFERENCE_ALREADY_REVERSED")).toHaveLength(4);
    await expectConsistent(wallet.id, "100.00");
  });

  test.each([
    ["valor diferente", "AMOUNT_MISMATCH", "BET", "29.99", {}],
    ["referência a uma WIN", "INVALID_REFERENCE_KIND", "WIN", "30.00", {}],
    ["rodada diferente", "REFERENCE_MISMATCH", "BET", "30.00", { roundId: "other-round" }],
  ] as const)("recusa %s com %s", async (_label, code, referencedKind, refundAmount, overrides) => {
    const wallet = await openWallet();
    const referenced = operation(wallet, referencedKind, "30.00");
    await processWager.execute(referenced);
    const balanceBefore = (await getWallet.execute(wallet.id)).balance.toString();

    const refund = await processWager.execute(
      operation(wallet, "REFUND", refundAmount, referenced.externalTransactionId, overrides),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(code);
    await expectConsistent(wallet.id, balanceBefore);
  });

  test("recusa a reversão de uma aposta que foi recusada", async () => {
    const wallet = await openWallet("10.00");
    const bet = operation(wallet, "BET", "50.00");
    await processWager.execute(bet);

    const refund = await processWager.execute(
      operation(wallet, "REFUND", "50.00", bet.externalTransactionId),
    );

    expect(refund.failureCode).toBe("REFERENCE_NOT_PROCESSED");
    await expectConsistent(wallet.id, "10.00");
  });
});

describe("ROLLBACK", () => {
  test("inverte uma WIN e um REFUND", async () => {
    const wallet = await openWallet();
    const win = operation(wallet, "WIN", "50.00");
    await processWager.execute(win);
    const bet = operation(wallet, "BET", "20.00");
    await processWager.execute(bet);
    const refund = operation(wallet, "REFUND", "20.00", bet.externalTransactionId);
    await processWager.execute(refund);
    await expectConsistent(wallet.id, "150.00");

    const rollbackWin = await processWager.execute(
      operation(wallet, "ROLLBACK", "50.00", win.externalTransactionId),
    );
    const rollbackRefund = await processWager.execute(
      operation(wallet, "ROLLBACK", "20.00", refund.externalTransactionId),
    );

    expect(rollbackWin.status).toBe(WagerTransactionStatus.Processed);
    expect(rollbackRefund.status).toBe(WagerTransactionStatus.Processed);
    await expectConsistent(wallet.id, "80.00");
  });

  test("reversão que deixaria saldo negativo é recusada com código próprio", async () => {
    const wallet = await openWallet();
    const win = operation(wallet, "WIN", "50.00");
    await processWager.execute(win);
    await processWager.execute(operation(wallet, "BET", "140.00"));

    const rollback = await processWager.execute(
      operation(wallet, "ROLLBACK", "50.00", win.externalTransactionId),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    await expectConsistent(wallet.id, "10.00");
  });
});

describe("Referência fora de ordem (PENDING_REFERENCE)", () => {
  /** Roda o worker até a transação sair de PENDING_REFERENCE (outras pendências podem existir no banco). */
  async function runWorkerUntilResolved(externalId: string, now: Date, maxAttempts = 10) {
    for (let i = 0; i < 1000; i++) {
      const current = await getTransaction.byProviderReference("provider-a", externalId);
      if (current.status !== WagerTransactionStatus.PendingReference) {
        return current;
      }
      const outcome = await processWager.retryPendingReference(
        { maxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
        now,
      );
      if (outcome === undefined) {
        now = new Date(now.getTime() + 10);
      }
    }
    throw new Error("pending reference was not resolved");
  }

  test("REFUND antes da BET fica pendente e é aplicado quando a BET chega", async () => {
    const wallet = await openWallet();
    const betExternalId = `bet-${newId()}`;
    const refund = operation(wallet, "REFUND", "25.00", betExternalId);

    const pending = await processWager.execute(refund);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await expectConsistent(wallet.id, "100.00");

    const replayWhilePending = await processWager.execute(refund);
    expect(replayWhilePending.idempotentReplay).toBe(true);
    expect(replayWhilePending.status).toBe(WagerTransactionStatus.PendingReference);

    await processWager.execute({ ...betInput(wallet, betExternalId, "25.00"), kind: "BET" });
    await expectConsistent(wallet.id, "75.00");

    const resolved = await runWorkerUntilResolved(refund.externalTransactionId, new Date());
    expect(resolved.status).toBe(WagerTransactionStatus.Processed);
    await expectConsistent(wallet.id, "100.00");

    const replayAfter = await processWager.execute(refund);
    expect(replayAfter.status).toBe(WagerTransactionStatus.Processed);
  });

  test("esgotadas as tentativas, a pendência é recusada com REFERENCE_NOT_FOUND", async () => {
    const wallet = await openWallet();
    const refund = operation(wallet, "REFUND", "25.00", `never-${newId()}`);
    await processWager.execute(refund);

    const expired = await runWorkerUntilResolved(refund.externalTransactionId, new Date(), 2);

    expect(expired.status).toBe(WagerTransactionStatus.Rejected);
    expect(expired.failureCode).toBe("REFERENCE_NOT_FOUND");
    await expectConsistent(wallet.id, "100.00");
  });
});
