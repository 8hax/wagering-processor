import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../../shared/domain/money";
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
  Wallet,
} from "./wallet";
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from "./wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

const OPENED_AT = new Date("2026-11-04T12:00:00.000Z");
const MOVED_AT = new Date("2026-11-04T12:05:00.000Z");

function openWallet(initialBalance: string) {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initialBalance),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    now: OPENED_AT,
  });
}

function movement(amount: Money, n: number = 1) {
  return {
    money: amount,
    transactionId: `tx-${n}`,
    entryId: `entry-${n}`,
    at: MOVED_AT,
  };
}

describe("Wallet.open", () => {
  test("abre com o saldo inicial, versão 1 e um lançamento de abertura", () => {
    const { wallet, openingEntry } = openWallet("100.00");

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry?.balanceAfter.toString()).toBe("100.00");
  });

  test("saldo inicial zero não gera lançamento", () => {
    const { wallet, openingEntry } = openWallet("0.00");

    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });
});

describe("Wallet.debit", () => {
  test("debita, incrementa a versão e devolve um lançamento balanceado", () => {
    const { wallet } = openWallet("100.00");

    const entry = wallet.debit(movement(brl("25.00")));

    expect(wallet.balance.toString()).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("75.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("permite debitar exatamente o saldo inteiro", () => {
    const { wallet } = openWallet("100.00");

    wallet.debit(movement(brl("100.00")));

    expect(wallet.balance.toString()).toBe("0.00");
  });

  test("rejeita saldo insuficiente sem alterar o estado", () => {
    const { wallet } = openWallet("100.00");

    expect(() => wallet.debit(movement(brl("100.01")))).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejeita moeda diferente da carteira", () => {
    const { wallet } = openWallet("100.00");

    expect(() => wallet.debit(movement(usd("10.00")))).toThrow(
      CurrencyMismatchError,
    );
  });

  test("rejeita valor zero", () => {
    const { wallet } = openWallet("100.00");

    expect(() => wallet.debit(movement(brl("0.00")))).toThrow(
      InvalidWalletOperationError,
    );
  });
});

describe("Wallet.credit", () => {
  test("credita e incrementa a versão", () => {
    const { wallet } = openWallet("100.00");

    const entry = wallet.credit(movement(brl("50.00")));

    expect(wallet.balance.toString()).toBe("150.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });
});

describe("Invariante: saldo == saldo reconstruído pelo ledger", () => {
  test("após várias movimentações, a soma do extrato bate com o saldo", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    expect(openingEntry).toBeDefined();

    const entries = [
      openingEntry!,
      wallet.debit(movement(brl("30.00"), 1)),
      wallet.credit(movement(brl("50.00"), 2)),
      wallet.debit(movement(brl("20.00"), 3)),
    ];

    const reconstructed = entries.reduce(
      (total, entry) =>
        entry.direction === LedgerDirection.Credit
          ? total.add(entry.money)
          : total.subtract(entry.money),
      Money.zero("BRL"),
    );

    expect(reconstructed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(4);
  });
});

describe("WalletLedgerEntry.create", () => {
  const base = {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    createdAt: MOVED_AT,
  };

  test("rejeita aritmética que não fecha", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("25.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("80.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita lançamento que deixaria o saldo negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("20.00"),
        balanceBefore: brl("10.00"),
        balanceAfter: brl("10.00").subtract(brl("20.00")),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});