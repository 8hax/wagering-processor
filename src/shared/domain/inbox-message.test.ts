import { describe, expect, test } from "bun:test";
import { InboxMessage, InboxMessageAlreadyProcessedError } from "./inbox-message";

const NOW = new Date("2026-11-06T12:00:00.000Z");

describe("InboxMessage", () => {
  test("nasce não processada e só pode ser processada uma vez", () => {
    const message = InboxMessage.receive({
      consumerName: "wager-transactions-consumer",
      messageId: "msg-1",
      payloadHash: "a".repeat(64),
      receivedAt: NOW,
    });

    expect(message.isProcessed()).toBe(false);

    message.markProcessed(NOW);

    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(NOW)).toThrow(InboxMessageAlreadyProcessedError);
  });
});
