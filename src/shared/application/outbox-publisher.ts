import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable, Logger } from "@nestjs/common";
import { claimDueOutboxMessages, saveOutboxDelivery } from "../infra/outbox.sql";
import { outboxPublishedTotal, outboxPublishRetriesTotal } from "../observability/metrics";
import { EventPublisher } from "./event-publisher";

export interface PublishBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica um lote de eventos pendentes da outbox.
 *
 * Tudo acontece numa transação: as mensagens são reivindicadas com FOR UPDATE SKIP LOCKED,
 * publicadas e marcadas. Se o processo morrer no meio, a transação é desfeita, as linhas
 * são destravadas e outra instância as publica. A entrega é at-least-once: um evento pode
 * ser publicado de novo se o processo morrer depois de enviar e antes do commit.
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
  ) {}

  async publishBatch(limit = 50, now: Date = new Date()): Promise<PublishBatchResult> {
    return this.orm.em.fork().transactional(async (em) => {
      const messages = await claimDueOutboxMessages(em, now, limit);
      let published = 0;
      let failed = 0;

      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          message.markPublished(new Date());
          published += 1;
          outboxPublishedTotal.inc({ event_type: message.eventType });
        } catch (error) {
          message.scheduleRetry(now);
          failed += 1;
          outboxPublishRetriesTotal.inc();
          this.logger.warn("outbox publish failed, retry scheduled", {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            reason: error instanceof Error ? error.name : "UNKNOWN",
          });
        }
        await saveOutboxDelivery(em, message);
      }

      return { claimed: messages.length, published, failed };
    });
  }
}
