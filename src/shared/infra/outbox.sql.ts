import { EntityManager } from "@mikro-orm/postgresql";
import { IntegrationEvent } from "../application/integration-event";
import { OutboxMessage } from "../domain/outbox-message";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

function toOutboxMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at === null ? undefined : new Date(row.next_attempt_at),
    publishedAt: row.published_at === null ? undefined : new Date(row.published_at),
  });
}

export async function insertOutboxEvents(
  em: EntityManager,
  events: IntegrationEvent<unknown>[],
): Promise<void> {
  for (const event of events) {
    const message = OutboxMessage.enqueue(event);
    await em.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       values (?, ?, ?, ?::jsonb, ?)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
      ],
    );
  }
}

/**
 * Reivindica mensagens pendentes e vencidas, travando as linhas até o fim da transação.
 * SKIP LOCKED faz cada publicador pular as linhas já reivindicadas por outro,
 * então publicadores concorrentes dividem o trabalho sem esperar nem duplicar.
 */
export async function claimDueOutboxMessages(
  em: EntityManager,
  now: Date,
  limit: number,
): Promise<OutboxMessage[]> {
  const rows = (await em.execute(
    `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
       from outbox_messages
      where published_at is null
        and (next_attempt_at is null or next_attempt_at <= ?)
      order by occurred_at, id
      limit ?
      for update skip locked`,
    [now, limit],
  )) as OutboxRow[];
  return rows.map(toOutboxMessage);
}

export async function saveOutboxDelivery(em: EntityManager, message: OutboxMessage): Promise<void> {
  await em.execute(
    `update outbox_messages
        set attempts = ?, next_attempt_at = ?, published_at = ?
      where id = ?`,
    [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
  );
}
