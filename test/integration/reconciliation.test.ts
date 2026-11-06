import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { newId } from "../../src/shared/infra/ids";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { GetWalletUseCase } from "../../src/wallet/application/get-wallet.use-case";
import { ReconcileWalletUseCase } from "../../src/wallet/application/reconcile-wallet.use-case";
import { betInput } from "./support/helpers";

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let getWallet: GetWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;
let reconcileWallet: ReconcileWalletUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  getWallet = new GetWalletUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);
  reconcileWallet = new ReconcileWalletUseCase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

describe("Reconciliação de carteira", () => {
  test("carteira com apostas está consistente com o extrato", async () => {
    const wallet = await createWallet.execute({
      playerId: newId(),
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });
    for (let i = 0; i < 3; i++) {
      await processWager.execute(betInput(wallet, `bet-${newId()}`, "25.00"));
    }

    const result = await reconcileWallet.execute(wallet.id);

    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe("925.00");
    expect(result.calculatedBalance.amount).toBe("925.00");
    expect(result.difference.amount).toBe("0.00");
    expect(result.checkedEntries).toBe(4);
  });

  test("divergência é detectada, sinalizada e NÃO corrigida", async () => {
    const wallet = await createWallet.execute({
      playerId: newId(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await orm.em
      .fork()
      .execute("update wallets set balance = balance + 1.00 where id = ?", [wallet.id]);

    const result = await reconcileWallet.execute(wallet.id);

    expect(result.consistent).toBe(false);
    expect(result.storedBalance.amount).toBe("101.00");
    expect(result.calculatedBalance.amount).toBe("100.00");
    expect(result.difference.amount).toBe("1.00");

    const unchanged = await getWallet.execute(wallet.id);
    expect(unchanged.balance.toString()).toBe("101.00");
  });
});