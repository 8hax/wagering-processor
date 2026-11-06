import { describe, expect, test } from "bun:test";
import {
  OUTBOX_MAX_RETRY_DELAY_MS,
  OutboxMessage,
  OutboxMessageAlreadyPublishedError,
} from "./outbox-message";

const NOW = new Date("2026-11-06T12:00:00.000Z");

function pending(attempts = 0) {
  return OutboxMessage.rehydrate({
    id: "event-1",
    aggregateId: "wallet-1",
    eventType: "WalletBalanceChanged",
    payload: { eventId: "event-1" },
    occurredAt: NOW,
    attempts,
    nextAttemptAt: undefined,
    publishedAt: undefined,
  });
}

const secondsAfterNow = (message: OutboxMessage) =>
  ((message.nextAttemptAt?.getTime() ?? 0) - NOW.getTime()) / 1000;

describe("OutboxMessage", () => {
  test("mensagem nova está pendente e pronta para publicar", () => {
    const message = pending();

    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  test("markPublished encerra a mensagem", () => {
    const message = pending();

    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(OutboxMessageAlreadyPublishedError);
  });

  test("cada falha dobra a espera até a próxima tentativa", () => {
    const message = pending();

    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    expect(secondsAfterNow(message)).toBe(1);
    expect(message.isDue(NOW)).toBe(false);

    message.scheduleRetry(NOW);
    expect(secondsAfterNow(message)).toBe(2);

    message.scheduleRetry(NOW);
    expect(secondsAfterNow(message)).toBe(4);
  });

  test("a espera tem um teto, e a mensagem nunca é descartada", () => {
    const message = pending(30);

    message.scheduleRetry(NOW);

    expect(secondsAfterNow(message) * 1000).toBe(OUTBOX_MAX_RETRY_DELAY_MS);
    expect(message.isPending()).toBe(true);
  });
});
