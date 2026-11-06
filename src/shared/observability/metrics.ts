import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();

export const wagerTransactionsTotal = new Counter({
  name: "wagering_transactions_total",
  help: "Wager transactions handled, by kind and final status",
  labelNames: ["kind", "status"] as const,
  registers: [metricsRegistry],
});

export const idempotentReplaysTotal = new Counter({
  name: "wagering_idempotent_replays_total",
  help: "Duplicate requests answered with the original result",
  registers: [metricsRegistry],
});

export const idempotencyConflictsTotal = new Counter({
  name: "wagering_idempotency_conflicts_total",
  help: "Requests reusing an idempotency key with a different payload",
  registers: [metricsRegistry],
});

export const walletConcurrencyConflictsTotal = new Counter({
  name: "wallet_concurrency_conflicts_total",
  help: "Wallet updates rejected by the optimistic version check",
  registers: [metricsRegistry],
});

export const reconciliationDivergencesTotal = new Counter({
  name: "wallet_reconciliation_divergences_total",
  help: "Reconciliations where the stored balance did not match the ledger",
  registers: [metricsRegistry],
});

export const wagerProcessingDuration = new Histogram({
  name: "wagering_processing_duration_seconds",
  help: "Time to handle a wager transaction request",
  labelNames: ["outcome"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});

export const outboxPendingMessages = new Gauge({
  name: "outbox_pending_messages",
  help: "Integration events waiting to be published",
  registers: [metricsRegistry],
});

export const outboxOldestPendingAgeSeconds = new Gauge({
  name: "outbox_oldest_pending_age_seconds",
  help: "Age of the oldest unpublished event (outbox lag)",
  registers: [metricsRegistry],
});
export const outboxPublishedTotal = new Counter({
  name: "outbox_published_total",
  help: "Integration events published to the broker",
  labelNames: ["event_type"] as const,
  registers: [metricsRegistry],
});

export const outboxPublishRetriesTotal = new Counter({
  name: "outbox_publish_retries_total",
  help: "Failed publish attempts scheduled for retry with backoff",
  registers: [metricsRegistry],
});

export const sqsMessagesConsumedTotal = new Counter({
  name: "sqs_messages_consumed_total",
  help: "Messages handled by the SQS consumer, by outcome",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

export const sqsMessageRetriesTotal = new Counter({
  name: "sqs_message_retries_total",
  help: "Messages left on the queue for redelivery after a transient failure",
  registers: [metricsRegistry],
});

export const sqsDeadLetteredTotal = new Counter({
  name: "sqs_dead_lettered_total",
  help: "Messages sent to the dead letter queue by the consumer",
  registers: [metricsRegistry],
});
