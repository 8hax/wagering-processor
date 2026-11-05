import { EntityManager } from "@mikro-orm/postgresql";
import { IntegrationEvent } from "../application/integration-event";

export async function insertOutboxEvents(
  em: EntityManager,
  events: IntegrationEvent<unknown>[],
): Promise<void> {
  for (const event of events) {
    await em.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       values (?, ?, ?, ?::jsonb, ?)`,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.toJSON()),
        event.occurredAt,
      ],
    );
  }
}