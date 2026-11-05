import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

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