import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { newId } from "../../src/shared/infra/ids";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { UnsupportedTransactionKindError } from "../../src/wagering/application/wagering.errors";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { GetWalletUseCase } from "../../src/wallet/application/get-wallet.use-case";
import { betInput, ledgerOf, reconstructBalance } from "./support/helpers";

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let getWallet: GetWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  Logger.overrideLogger(["warn", "error"]);
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  getWallet = new GetWalletUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

function openWallet(amount: string) {
  return createWallet.execute({
    playerId: newId(),
    initialBalance: { amount, currency: "BRL" },
  });
}

async function outboxEventTypes(transactionId: string): Promise<string[]> {
  const rows = (await orm.em.fork().execute(
    `select event_type from outbox_messages
      where payload->>'causationId' = ?
      order by event_type`,
    [transactionId],
  )) as { event_type: string }[];
  return rows.map((row) => row.event_type);
}

async function expectLedgerMatchesBalance(walletId: string) {
  const wallet = await getWallet.execute(walletId);
  const reconstructed = reconstructBalance(await ledgerOf(orm, walletId), wallet.currency);
  expect(reconstructed.equals(wallet.balance)).toBe(true);
  return wallet;
}

describe("WIN", () => {
  test("credita o saldo, gera um lançamento CREDIT e os dois eventos", async () => {
    const wallet = await openWallet("100.00");

    const result = await processWager.execute({
      ...betInput(wallet, `win-${newId()}`, "50.00"),
      kind: "WIN",
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe("150.00");
    expect(await outboxEventTypes(result.transactionId)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);

    const after = await expectLedgerMatchesBalance(wallet.id);
    expect(after.version).toBe(2);
  });

  test("WIN repetida é replay e não credita duas vezes", async () => {
    const wallet = await openWallet("100.00");
    const input = { ...betInput(wallet, `win-${newId()}`, "50.00"), kind: "WIN" };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => processWager.execute({ ...input, correlationId: newId() })),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    const credits = (await ledgerOf(orm, wallet.id)).filter(
      (entry) => entry.direction === "CREDIT",
    );
    expect(credits).toHaveLength(2);

    const after = await expectLedgerMatchesBalance(wallet.id);
    expect(after.balance.toString()).toBe("150.00");
  });
});

describe("LOSS", () => {
  test("é processada sem mexer no saldo, na versão ou no extrato", async () => {
    const wallet = await openWallet("100.00");

    const result = await processWager.execute({
      ...betInput(wallet, `loss-${newId()}`, "25.00"),
      kind: "LOSS",
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe("100.00");
    expect(await outboxEventTypes(result.transactionId)).toEqual(["WagerTransactionProcessed"]);

    const entries = await ledgerOf(orm, wallet.id);
    expect(entries).toHaveLength(1);

    const after = await expectLedgerMatchesBalance(wallet.id);
    expect(after.version).toBe(1);
  });
});

describe("Rodada completa e operações não suportadas", () => {
  test("BET seguida de WIN mantém o extrato consistente", async () => {
    const wallet = await openWallet("100.00");

    await processWager.execute(betInput(wallet, `bet-${newId()}`, "30.00"));
    await processWager.execute({ ...betInput(wallet, `win-${newId()}`, "75.00"), kind: "WIN" });

    const after = await expectLedgerMatchesBalance(wallet.id);
    expect(after.balance.toString()).toBe("145.00");
    expect(after.version).toBe(3);
  });

  test("REFUND ainda não é suportado", async () => {
    const wallet = await openWallet("100.00");

    await expect(
      processWager.execute({
        ...betInput(wallet, `refund-${newId()}`, "10.00"),
        kind: "REFUND",
        referenceExternalTransactionId: "bet-x",
      }),
    ).rejects.toThrow(UnsupportedTransactionKindError);
  });
});
