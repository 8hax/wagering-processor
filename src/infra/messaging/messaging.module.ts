import { Global, Module } from "@nestjs/common";
import { EventPublisher } from "../../shared/application/event-publisher";
import { OutboxPublisher } from "../../shared/application/outbox-publisher";
import { OutboxPublisherWorker } from "../../shared/infra/outbox-publisher.worker";
import { SqsEventPublisher, sqsOptionsFromEnv } from "./sqs-event-publisher";

@Global()
@Module({
  providers: [
    { provide: EventPublisher, useFactory: () => new SqsEventPublisher(sqsOptionsFromEnv()) },
    OutboxPublisher,
    OutboxPublisherWorker,
  ],
  exports: [EventPublisher],
})
export class MessagingModule {}
