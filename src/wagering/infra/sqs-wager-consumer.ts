import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { payloadHash } from "../../shared/application/payload-hash";
import { DomainError } from "../../shared/domain/domain-error";
import { InboxMessage } from "../../shared/domain/inbox-message";
import {
  sqsDeadLetteredTotal,
  sqsMessageRetriesTotal,
  sqsMessagesConsumedTotal,
} from "../../shared/observability/metrics";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction.use-case";
import { ConcurrentWalletUpdateError } from "../../wallet/application/wallet.errors";
import { DuplicateInboxMessageError } from "../application/wagering.errors";

export const CONSUMER_NAME = "wager-transactions-consumer";

export type ConsumeOutcome = "processed" | "duplicate" | "business-error" | "retry" | "dead-lettered";

export interface SqsWagerConsumerOptions {
  queueName: string;
  deadLetterQueueName: string;
  /** Entregas antes de o SQS mover a mensagem para a DLQ (redrive policy). */
  maxReceiveCount: number;
  /** Base do backoff de visibilidade após falha transitória: base * 2^(entregas - 1), em segundos. */
  retryBaseSeconds: number;
  waitTimeSeconds: number;
  endpoint?: string;
  region: string;
}

export function consumerOptionsFromEnv(): SqsWagerConsumerOptions {
  return {
    queueName: process.env.WAGER_QUEUE_NAME ?? "wager-transactions.fifo",
    deadLetterQueueName: process.env.WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo",
    maxReceiveCount: Number(process.env.WAGER_MAX_RECEIVE_COUNT ?? 5),
    retryBaseSeconds: Number(process.env.WAGER_RETRY_BASE_SECONDS ?? 2),
    waitTimeSeconds: Number(process.env.WAGER_WAIT_TIME_SECONDS ?? 5),
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.AWS_REGION ?? "us-east-1",
  };
}

const WagerMessageSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string(),
  data: z.object({
    providerId: z.string().min(1).max(100),
    externalTransactionId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(255),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().min(1).max(200),
    gameId: z.string().min(1).max(200),
    kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: z.string().min(1).max(200).optional(),
  }),
});

/**
 * Consome a fila de transações e reutiliza o mesmo use case da entrada HTTP.
 *
 * - ack (DeleteMessage) só depois do commit;
 * - reentrega da mesma mensagem: a inbox (mesma transação SQL) detecta e a mensagem é confirmada sem efeito;
 * - erro de negócio (DomainError): terminal, a mensagem é confirmada;
 * - erro transitório: a mensagem não é confirmada e volta após um backoff de visibilidade;
 *   ao exceder maxReceiveCount, o próprio SQS a move para a DLQ (redrive policy);
 * - mensagem malformada: erro permanente, enviada diretamente para a DLQ.
 */
export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly client: SQSClient;
  private queues: Promise<{ queueUrl: string; deadLetterQueueUrl: string }> | undefined;

  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly options: SqsWagerConsumerOptions = consumerOptionsFromEnv(),
  ) {
    this.client = new SQSClient({ region: options.region, endpoint: options.endpoint, maxAttempts: 2 });
  }

  /** Recebe um lote e trata cada mensagem; para no meio se shouldStop() ficar verdadeiro. */
  async pollOnce(shouldStop: () => boolean = () => false): Promise<ConsumeOutcome[]> {
    const { queueUrl } = await this.resolveQueues();
    let received;
    try {
      received = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );
    } catch (error) {
      // A fila pode ter deixado de existir (ex.: o emulador reiniciou): a próxima volta a recria.
      this.queues = undefined;
      throw error;
    }

    const outcomes: ConsumeOutcome[] = [];
    for (const message of received.Messages ?? []) {
      if (shouldStop()) {
        await this.releaseForRedelivery(queueUrl, message);
        continue;
      }
      outcomes.push(await this.handle(queueUrl, message));
    }
    return outcomes;
  }

  async queueUrls(): Promise<{ queueUrl: string; deadLetterQueueUrl: string }> {
    return this.resolveQueues();
  }

  destroy(): void {
    this.client.destroy();
  }

  private async handle(queueUrl: string, message: Message): Promise<ConsumeOutcome> {
    const parsed = WagerMessageSchema.safeParse(safeJson(message.Body));
    if (!parsed.success) {
      await this.deadLetter(queueUrl, message, "INVALID_MESSAGE");
      return this.count("dead-lettered");
    }

    const body = parsed.data;
    const inbox = InboxMessage.receive({
      consumerName: CONSUMER_NAME,
      messageId: body.messageId,
      payloadHash: payloadHash(body.data),
      receivedAt: new Date(),
    });
    const { idempotencyKey, ...data } = body.data;

    try {
      await this.processWager.execute(
        { ...data, idempotencyKey, correlationId: body.messageId },
        { inbox },
      );
      await this.ack(queueUrl, message);
      return this.count("processed");
    } catch (error) {
      if (error instanceof DuplicateInboxMessageError) {
        await this.ack(queueUrl, message);
        return this.count("duplicate");
      }
      if (error instanceof DomainError && !(error instanceof ConcurrentWalletUpdateError)) {
        this.logger.warn("wager message rejected by business rule", {
          messageId: body.messageId,
          errorCode: error.code,
        });
        await this.ack(queueUrl, message);
        return this.count("business-error");
      }
      await this.retryLater(queueUrl, message, body.messageId);
      return this.count("retry");
    }
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async retryLater(queueUrl: string, message: Message, messageId: string): Promise<void> {
    const deliveries = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delay = Math.min(this.options.retryBaseSeconds * 2 ** (deliveries - 1), 900);
    sqsMessageRetriesTotal.inc();
    this.logger.warn("transient failure, message will be redelivered", {
      messageId,
      deliveries,
      retryInSeconds: delay,
    });
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );
  }

  private async releaseForRedelivery(queueUrl: string, message: Message): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string): Promise<void> {
    const { deadLetterQueueUrl } = await this.resolveQueues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: "invalid",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
      }),
    );
    await this.ack(queueUrl, message);
    sqsDeadLetteredTotal.inc();
    this.logger.warn("malformed message sent to the dead letter queue", {
      sqsMessageId: message.MessageId,
      reason,
    });
  }

  private count(outcome: ConsumeOutcome): ConsumeOutcome {
    sqsMessagesConsumedTotal.inc({ outcome });
    return outcome;
  }

  /** Cria (de forma idempotente) a DLQ e a fila principal com a redrive policy apontando para ela. */
  private resolveQueues(): Promise<{ queueUrl: string; deadLetterQueueUrl: string }> {
    this.queues ??= (async () => {
      const dlq = await this.client.send(
        new CreateQueueCommand({
          QueueName: this.options.deadLetterQueueName,
          Attributes: { FifoQueue: "true" },
        }),
      );
      const deadLetterQueueUrl = required(dlq.QueueUrl, this.options.deadLetterQueueName);
      const attributes = await this.client.send(
        new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ["QueueArn"] }),
      );
      const main = await this.client.send(
        new CreateQueueCommand({
          QueueName: this.options.queueName,
          Attributes: {
            FifoQueue: "true",
            VisibilityTimeout: "30",
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: required(attributes.Attributes?.QueueArn, "dlq arn"),
              maxReceiveCount: this.options.maxReceiveCount,
            }),
          },
        }),
      );
      return { queueUrl: required(main.QueueUrl, this.options.queueName), deadLetterQueueUrl };
    })().catch((error: unknown) => {
      this.queues = undefined;
      throw error;
    });
    return this.queues;
  }
}

function safeJson(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? "");
  } catch {
    return undefined;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`could not resolve ${name}`);
  }
  return value;
}
