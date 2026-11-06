import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { EventPublisher } from "../../shared/application/event-publisher";
import { OutboxMessage } from "../../shared/domain/outbox-message";

export interface SqsEventPublisherOptions {
  queueName: string;
  endpoint?: string;
  region: string;
}

export function sqsOptionsFromEnv(): SqsEventPublisherOptions {
  return {
    queueName: process.env.EVENTS_QUEUE_NAME ?? "wagering-events.fifo",
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.AWS_REGION ?? "us-east-1",
  };
}

/**
 * Publica os eventos da outbox numa fila SQS FIFO.
 * - MessageGroupId = aggregateId: o SQS entrega os eventos do mesmo agregado na ordem em que foram
 *   enviados. Com falha do broker ou publicadores concorrentes, o envio pode sair fora de ordem
 *   (limitação documentada); os eventos de carteira levam walletVersion para o consumidor ordenar.
 * - MessageDeduplicationId = eventId: se o mesmo evento for reenviado (ex.: o processo morreu
 *   depois de publicar e antes do commit), o SQS descarta a cópia dentro da janela de deduplicação.
 *   Fora dessa janela, o consumidor deduplica pelo eventId.
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher implements OnApplicationShutdown {
  private readonly client: SQSClient;
  private queueUrl: Promise<string> | undefined;

  constructor(private readonly options: SqsEventPublisherOptions = sqsOptionsFromEnv()) {
    super();
    this.client = new SQSClient({ region: options.region, endpoint: options.endpoint, maxAttempts: 2 });
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.withQueue((queueUrl) =>
      this.client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: "String", StringValue: message.eventType },
          },
        }),
      ),
    );
  }

  /** Consulta a fila de verdade a cada chamada: a readiness precisa detectar o SQS fora do ar. */
  async ping(): Promise<void> {
    await this.withQueue((queueUrl) =>
      this.client.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
      ),
    );
  }

  async queueUrlForTests(): Promise<string> {
    return this.resolveQueueUrl();
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  /**
   * Executa a chamada com a URL da fila. Em caso de falha, esquece a URL guardada: se a fila
   * deixou de existir (ex.: o emulador reiniciou sem persistência), a próxima tentativa a recria.
   */
  private async withQueue<T>(call: (queueUrl: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.resolveQueueUrl());
    } catch (error) {
      this.queueUrl = undefined;
      throw error;
    }
  }

  /** CreateQueue é idempotente: devolve a URL da fila, criando-a se ainda não existir. */
  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.client
      .send(
        new CreateQueueCommand({
          QueueName: this.options.queueName,
          Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
        }),
      )
      .then((result) => {
        if (!result.QueueUrl) {
          throw new Error(`could not resolve queue ${this.options.queueName}`);
        }
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
