import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const NOW = new Date("2026-11-05T12:00:00.000Z");

function props(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "a".repeat(64),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    referenceExternalTransactionId: undefined,
    createdAt: NOW,
    ...overrides,
  };
}

describe("WagerTransaction.create", () => {
  test("nasce PENDING", () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
  });

  test("REFUND sem referência é rejeitado", () => {
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Refund })),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS aceita valor zero, porque não mexe no saldo", () => {
    const transaction = WagerTransaction.create(
      props({ kind: WagerTransactionKind.Loss, money: brl("0.00") }),
    );

    expect(transaction.affectsBalance()).toBe(false);
  });

  test("BET com valor zero é rejeitada", () => {
    expect(() => WagerTransaction.create(props({ money: brl("0.00") }))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe("WagerTransaction: transições", () => {
  test("markProcessed registra o saldo observado e a data", () => {
    const transaction = WagerTransaction.create(props());

    transaction.markProcessed(brl("75.00"), NOW);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.observedBalance?.toString()).toBe("75.00");
    expect(transaction.processedAt).toBe(NOW);
  });

  test("reject registra o código de falha", () => {
    const transaction = WagerTransaction.create(props());

    transaction.reject("INSUFFICIENT_FUNDS", brl("10.00"), NOW);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
  });

  test("uma transação final não pode mudar de estado", () => {
    const transaction = WagerTransaction.create(props());
    transaction.markProcessed(brl("75.00"), NOW);

    expect(() => transaction.reject("INSUFFICIENT_FUNDS", brl("75.00"), NOW)).toThrow(
      InvalidTransactionStateError,
    );
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test("matchesPayload compara a impressão digital", () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.matchesPayload("a".repeat(64))).toBe(true);
    expect(transaction.matchesPayload("b".repeat(64))).toBe(false);
  });
});
describe("WagerTransaction: reversões (REFUND e ROLLBACK)", () => {
  const processed = (overrides: Parameters<typeof props>[0] = {}) => {
    const transaction = WagerTransaction.create(props(overrides));
    transaction.markProcessed(brl("75.00"), NOW);
    return transaction;
  };
  const reversal = (kind: WagerTransactionKind, overrides: Parameters<typeof props>[0] = {}) =>
    WagerTransaction.create(
      props({ id: "tx-2", externalTransactionId: "ext-2", kind, referenceExternalTransactionId: "ext-1", ...overrides }),
    );

  test("REFUND válido de uma BET processada não tem problema e credita", () => {
    const bet = processed();
    const refund = reversal(WagerTransactionKind.Refund);

    expect(refund.referenceProblem(bet)).toBeUndefined();
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da transação original", () => {
    expect(reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(processed())).toBe(LedgerDirection.Credit);

    const win = processed({ kind: WagerTransactionKind.Win });
    expect(reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test.each([
    ["valor diferente", { money: brl("10.00") }, "AMOUNT_MISMATCH"],
    ["outra carteira", { walletId: "wallet-2" }, "REFERENCE_MISMATCH"],
    ["outra rodada", { roundId: "round-2" }, "REFERENCE_MISMATCH"],
  ] as const)("recusa %s", (_label, overrides, code) => {
    expect(reversal(WagerTransactionKind.Refund, overrides).referenceProblem(processed())).toBe(code);
  });

  test("REFUND não pode referenciar uma WIN", () => {
    const win = processed({ kind: WagerTransactionKind.Win });
    expect(reversal(WagerTransactionKind.Refund).referenceProblem(win)).toBe("INVALID_REFERENCE_KIND");
  });

  test("referência que não foi processada é recusada", () => {
    const rejected = WagerTransaction.create(props());
    rejected.reject("INSUFFICIENT_FUNDS", brl("10.00"), NOW);
    expect(reversal(WagerTransactionKind.Refund).referenceProblem(rejected)).toBe("REFERENCE_NOT_PROCESSED");
  });

  test("PENDING_REFERENCE só nasce de PENDING e ainda pode ser resolvida", () => {
    const refund = reversal(WagerTransactionKind.Refund);
    refund.markPendingReference(brl("75.00"));

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.isTerminal()).toBe(false);
    expect(() => refund.markPendingReference(brl("75.00"))).toThrow(InvalidTransactionStateError);

    refund.markProcessed(brl("100.00"), NOW, "tx-1");
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.referenceTransactionId).toBe("tx-1");
  });
});
