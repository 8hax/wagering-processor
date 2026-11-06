import "reflect-metadata";
import { DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { SqsEventPublisher, sqsOptionsFromEnv } from "../../src/infra/messaging/sqs-event-publisher";
import { EventPublisher } from "../../src/shared/application/event-publisher";
import { OutboxPublisher } from "../../src/shared/application/outbox-publisher";
import { OutboxMessage } from "../../src/shared/domain/outbox-message";
import { newId } from "../../src/shared/infra/ids";
import { claimDueOutboxMessages } from "../../src/shared/infra/outbox.sql";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { betInput } from "./support/helpers";

/** Publicador real no SQS que também conta quantas vezes cada evento foi enviado. */
class CountingPublisher extends EventPublisher {
  readonly sentIds: string[] = [];

  constructor(private readonly inner: EventPublisher) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    this.sentIds.push(message.id);
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }
}

/** Injeta uma falha de broker na primeira tentativa de cada evento. */
class FailOncePublisher extends EventPublisher {
  private readonly failed = new Set<string>();

  constructor(private readonly inner: EventPublisher) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    if (!this.failed.has(message.id)) {
      this.failed.add(message.id);
      throw new Error("simulated broker outage");
    }
    await this.inner.publish(message);
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }
}

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;
let sqs: SqsEventPublisher;
let sqsClient: SQSClient;

beforeAll(async () => {
  Logger.overrideLogger(["error"]);
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);

  const options = { ...sqsOptionsFromEnv(), queueName: `test-events-${newId()}.fifo` };
  sqs = new SqsEventPublisher(options);
  sqsClient = new SQSClient({ region: options.region, endpoint: options.endpoint });
});

afterAll(async () => {
  await sqsClient.send(new DeleteQueueCommand({ QueueUrl: await sqs.queueUrlForTests() }));
  sqsClient.destroy();
  sqs.onApplicationShutdown();
  await orm.close(true);
});

/**
 * Cada teste parte de uma outbox sem pendências: o que sobrou de outras execuções
 * é marcado como publicado, para que só os eventos do próprio teste sejam contados.
 */
beforeEach(async () => {
  await orm.em.fork().execute("update outbox_messages set published_at = now() where published_at is null");
});

async function placeBets(count: number): Promise<void> {
  const wallet = await createWallet.execute({
    playerId: newId(),
    initialBalance: { amount: "1000.00", currency: "BRL" },
  });
  for (let i = 0; i < count; i++) {
    await processWager.execute(betInput(wallet, `bet-${newId()}`, "1.00"));
  }
}

async function pendingCount(): Promise<number> {
  const rows = (await orm.em
    .fork()
    .execute("select count(*) as pending from outbox_messages where published_at is null")) as {
    pending: string;
  }[];
  return Number(rows[0]?.pending ?? 0);
}

async function drain(publisher: OutboxPublisher, batchSize: number): Promise<void> {
  while ((await publisher.publishBatch(batchSize)).claimed > 0) {
    // continua até a outbox esvaziar
  }
}

describe("Publicador da outbox com SQS real", () => {
  test("publica os eventos pendentes na fila e os marca como publicados", async () => {
    await placeBets(2);
    expect(await pendingCount()).toBe(4);

    const result = await new OutboxPublisher(orm, sqs).publishBatch();

    expect(result).toEqual({ claimed: 4, published: 4, failed: 0 });
    expect(await pendingCount()).toBe(0);

    const received = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: await sqs.queueUrlForTests(),
        MaxNumberOfMessages: 10,
        MessageAttributeNames: ["All"],
      }),
    );
    const bodies = (received.Messages ?? []).map((message) => JSON.parse(message.Body ?? "{}"));
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.map((body) => body.eventType))).toEqual(
      new Set(["WagerTransactionProcessed", "WalletBalanceChanged"]),
    );
  });

  test("dois publishers concorrentes publicam cada evento exatamente uma vez", async () => {
    await placeBets(30);
    const first = new CountingPublisher(sqs);
    const second = new CountingPublisher(sqs);

    await Promise.all([
      drain(new OutboxPublisher(orm, first), 7),
      drain(new OutboxPublisher(orm, second), 7),
    ]);

    const all = [...first.sentIds, ...second.sentIds];
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect(first.sentIds.length).toBeGreaterThan(0);
    expect(second.sentIds.length).toBeGreaterThan(0);
    expect(await pendingCount()).toBe(0);
  });

  test("instância que morre com eventos reivindicados não os perde: outra instância publica", async () => {
    await placeBets(3);

    await expect(
      orm.em.fork().transactional(async (em) => {
        const claimed = await claimDueOutboxMessages(em, new Date(), 50);
        expect(claimed).toHaveLength(6);
        throw new Error("process crashed before publishing");
      }),
    ).rejects.toThrow("process crashed before publishing");

    expect(await pendingCount()).toBe(6);

    const result = await new OutboxPublisher(orm, sqs).publishBatch();
    expect(result.published).toBe(6);
    expect(await pendingCount()).toBe(0);
  });

  test("falha do broker agenda nova tentativa com backoff, sem perder o evento", async () => {
    await placeBets(1);
    const publisher = new OutboxPublisher(orm, new FailOncePublisher(sqs));
    const now = new Date();

    const firstTry = await publisher.publishBatch(50, now);
    expect(firstTry).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(await pendingCount()).toBe(2);

    const tooEarly = await publisher.publishBatch(50, now);
    expect(tooEarly.claimed).toBe(0);

    const later = new Date(now.getTime() + 60_000);
    const secondTry = await publisher.publishBatch(50, later);
    expect(secondTry).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(await pendingCount()).toBe(0);
  });
});
