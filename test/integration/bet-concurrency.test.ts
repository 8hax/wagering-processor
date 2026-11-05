import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { newId } from "../../src/shared/infra/ids";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { GetWalletUseCase } from "../../src/wallet/application/get-wallet.use-case";
import { betInput, ledgerOf, reconstructBalance } from "./support/helpers";
import { WagerTransactionStatus } from "../../src/wagering/domain/wager-transaction";

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let getWallet: GetWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  getWallet = new GetWalletUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

async function openWallet(amount: string) {
  return createWallet.execute({
    playerId: newId(),
    initialBalance: { amount, currency: "BRL" },
  });
}

async function expectLedgerMatchesBalance(walletId: string) {
  const wallet = await getWallet.execute(walletId);
  const reconstructed = reconstructBalance(await ledgerOf(orm, walletId), wallet.currency);
  expect(reconstructed.equals(wallet.balance)).toBe(true);
  return wallet;
}

describe("BET: concorrência contra o Postgres real", () => {
  test("cenário obrigatório: duas apostas de 80.00 sobre saldo de 100.00", async () => {
    const wallet = await openWallet("100.00");

    const results = await Promise.all([
      processWager.execute(betInput(wallet, `bet-a-${newId()}`, "80.00")),
      processWager.execute(betInput(wallet, `bet-b-${newId()}`, "80.00")),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(results.find((result) => result.status === "REJECTED")?.failureCode).toBe(
      "INSUFFICIENT_FUNDS",
    );

    const debits = (await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT");
    expect(debits).toHaveLength(1);

    const finalWallet = await expectLedgerMatchesBalance(wallet.id);
    expect(finalWallet.balance.toString()).toBe("20.00");
  });

  test("a mesma aposta enviada 50 vezes em paralelo gera um único débito", async () => {
    const wallet = await openWallet("100.00");
    const sameBet = `bet-${newId()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(betInput(wallet, sameBet, "25.00"))),
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(49);

    const debits = (await ledgerOf(orm, wallet.id)).filter((entry) => entry.direction === "DEBIT");
    expect(debits).toHaveLength(1);

    const finalWallet = await expectLedgerMatchesBalance(wallet.id);
    expect(finalWallet.balance.toString()).toBe("75.00");
  });

  test("carteira disputada: 20 apostas de 10.00 sobre saldo de 100.00", async () => {
    const wallet = await openWallet("100.00");

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        processWager.execute(betInput(wallet, `bet-${newId()}`, "10.00")),
      ),
    );

    expect(results.filter((result) => result.status === "PROCESSED")).toHaveLength(10);
    expect(results.filter((result) => result.status === "REJECTED")).toHaveLength(10);

    const finalWallet = await expectLedgerMatchesBalance(wallet.id);
    expect(finalWallet.balance.toString()).toBe("0.00");
  });

  test("carteiras diferentes processadas em paralelo não interferem entre si", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet("100.00")));

    const results = await Promise.all(
      wallets.map((wallet) => processWager.execute(betInput(wallet, `bet-${newId()}`, "30.00"))),
    );

    expect(results.every((result) => result.status === "PROCESSED")).toBe(true);
    for (const wallet of wallets) {
      const finalWallet = await expectLedgerMatchesBalance(wallet.id);
      expect(finalWallet.balance.toString()).toBe("70.00");
    }
  });

  test(
    "3 processos (instâncias) disputando a mesma carteira",
    async () => {
      const wallet = await openWallet("100.00");

      const workers = Array.from({ length: 3 }, () =>
        Bun.spawn(
          ["bun", "test/integration/support/bet-worker.ts", wallet.id, wallet.playerId, "10"],
          { stdout: "pipe", stderr: "inherit" },
        ),
      );

      const statuses = (
        await Promise.all(
          workers.map(async (worker) => {
            const output = await new Response(worker.stdout).text();
            expect(await worker.exited).toBe(0);
            const lastLine = output.trim().split("\n").at(-1) ?? "[]";
            return JSON.parse(lastLine) as string[];
          }),
        )
      ).flat();

      expect(statuses).toHaveLength(30);
      expect(statuses.filter((status) => status === "PROCESSED")).toHaveLength(10);
      expect(statuses.filter((status) => status === "REJECTED")).toHaveLength(20);

      const finalWallet = await expectLedgerMatchesBalance(wallet.id);
      expect(finalWallet.balance.toString()).toBe("0.00");
    },
    30_000,
  );
});