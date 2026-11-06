import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { newId } from "../../src/shared/infra/ids";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { IdempotencyConflictError } from "../../src/wagering/application/wagering.errors";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { GetWalletUseCase } from "../../src/wallet/application/get-wallet.use-case";
import { betInput, ledgerOf } from "./support/helpers";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction";

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

interface OutboxRow {
  event_type: string;
  aggregate_id: string;
}

async function outboxEventsCausedBy(transactionId: string): Promise<OutboxRow[]> {
  return (await orm.em.fork().execute(
    `select event_type, aggregate_id
       from outbox_messages
      where payload->>'causationId' = ?
      order by event_type`,
    [transactionId],
  )) as OutboxRow[];
}

describe("Idempotência", () => {
  test("mesma chave com payload diferente é conflito, e não replay", async () => {
    const wallet = await openWallet("100.00");
    const externalId = `bet-${newId()}`;

    await processWager.execute(betInput(wallet, externalId, "25.00"));

    await expect(
      processWager.execute(betInput(wallet, externalId, "30.00")),
    ).rejects.toThrow(IdempotencyConflictError);

    const debits = (await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT");
    expect(debits).toHaveLength(1);
    expect((await getWallet.execute(wallet.id)).balance.toString()).toBe("75.00");
  });
});

describe("Atomicidade: transação, extrato, saldo e outbox", () => {
  test("aposta processada gera débito, nova versão e dois eventos", async () => {
    const wallet = await openWallet("100.00");

    const result = await processWager.execute(betInput(wallet, `bet-${newId()}`, "40.00"));

    const events = await outboxEventsCausedBy(result.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(events.find((event) => event.event_type === "WalletBalanceChanged")?.aggregate_id).toBe(
      wallet.id,
    );

    const after = await getWallet.execute(wallet.id);
    expect(after.balance.toString()).toBe("60.00");
    expect(after.version).toBe(2);
  });

  test("aposta recusada gera um evento, sem lançamento e sem mudar a versão", async () => {
    const wallet = await openWallet("10.00");

    const result = await processWager.execute(betInput(wallet, `bet-${newId()}`, "50.00"));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    const events = await outboxEventsCausedBy(result.transactionId);
    expect(events.map((event) => event.event_type)).toEqual(["WagerTransactionRejected"]);

    const debits = (await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT");
    expect(debits).toHaveLength(0);

    const after = await getWallet.execute(wallet.id);
    expect(after.balance.toString()).toBe("10.00");
    expect(after.version).toBe(1);
  });
});

describe("Constraints do banco (defesa mesmo sem passar pelo código)", () => {
  test("saldo negativo é recusado pelo Postgres", async () => {
    const wallet = await openWallet("10.00");

    await expect(
      orm.em.fork().execute("update wallets set balance = -1 where id = ?", [wallet.id]),
    ).rejects.toThrow();
  });

  test("lançamentos do extrato não podem ser alterados", async () => {
    const wallet = await openWallet("10.00");

    await expect(
      orm.em
        .fork()
        .execute("update wallet_ledger_entries set amount = 1 where wallet_id = ?", [wallet.id]),
    ).rejects.toThrow();
  });

  test("transação em estado final não pode mudar de status", async () => {
    const wallet = await openWallet("100.00");
    const result = await processWager.execute(betInput(wallet, `bet-${newId()}`, "10.00"));

    await expect(
      orm.em
        .fork()
        .execute("update wager_transactions set status = 'FAILED', failure_code = 'X' where id = ?", [
          result.transactionId,
        ]),
    ).rejects.toThrow();
  });
});