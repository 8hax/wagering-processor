import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { InvalidCursorError } from "../../src/shared/application/cursor";
import { newId } from "../../src/shared/infra/ids";
import { GetWagerTransactionUseCase } from "../../src/wagering/application/get-wager-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { WagerTransactionNotFoundError } from "../../src/wagering/application/wagering.errors";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { ListWalletLedgerUseCase } from "../../src/wallet/application/list-wallet-ledger.use-case";
import { betInput } from "./support/helpers";

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;
let listLedger: ListWalletLedgerUseCase;
let getTransaction: GetWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);
  listLedger = new ListWalletLedgerUseCase(orm);
  getTransaction = new GetWagerTransactionUseCase(orm);
});

afterAll(async () => {
  await orm.close(true);
});

describe("Extrato paginado por cursor", () => {
  test("percorre todas as páginas sem repetir nem pular lançamentos", async () => {
    const wallet = await createWallet.execute({
      playerId: newId(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    for (let i = 0; i < 5; i++) {
      await processWager.execute(betInput(wallet, `bet-${newId()}`, "10.00"));
    }

    const first = await listLedger.execute(wallet.id, undefined, 4);
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();

    const second = await listLedger.execute(wallet.id, first.nextCursor ?? undefined, 4);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(6);
    expect(second.items.at(-1)?.balanceAfter.toString()).toBe("50.00");
  });

  test("cursor adulterado é recusado", async () => {
    const wallet = await createWallet.execute({
      playerId: newId(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });

    expect(listLedger.execute(wallet.id, "isto-nao-e-um-cursor", 10)).rejects.toThrow(
      InvalidCursorError,
    );
  });
});

describe("Consulta de transações", () => {
  test("encontra a mesma transação pelo id interno e pela referência do provedor", async () => {
    const wallet = await createWallet.execute({
      playerId: newId(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const input = betInput(wallet, `bet-${newId()}`, "30.00");
    const result = await processWager.execute(input);

    const byId = await getTransaction.byId(result.transactionId);
    const byReference = await getTransaction.byProviderReference(
      input.providerId,
      input.externalTransactionId,
    );

    expect(byId.id).toBe(result.transactionId);
    expect(byReference.id).toBe(result.transactionId);
    expect(byId.observedBalance?.toString()).toBe("70.00");
  });

  test("transação inexistente gera erro de não encontrada", async () => {
    expect(getTransaction.byId(newId())).rejects.toThrow(WagerTransactionNotFoundError);
  });
});