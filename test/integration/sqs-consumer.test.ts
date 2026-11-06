import "reflect-metadata";
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { payloadHash } from "../../src/shared/application/payload-hash";
import { InboxMessage } from "../../src/shared/domain/inbox-message";
import { newId } from "../../src/shared/infra/ids";
import {
  ProcessWagerInput,
  ProcessWagerOptions,
  ProcessWagerResult,
  ProcessWagerTransactionUseCase,
} from "../../src/wagering/application/process-wager-transaction.use-case";
import {
  CONSUMER_NAME,
  consumerOptionsFromEnv,
  SqsWagerConsumer,
  SqsWagerConsumerOptions,
} from "../../src/wagering/infra/sqs-wager-consumer";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import { Wallet } from "../../src/wallet/domain/wallet";
import { ledgerOf } from "./support/helpers";

/** Simula o banco indisponível: toda execução falha com um erro de infraestrutura. */
class UnavailableUseCase extends ProcessWagerTransactionUseCase {
  override async execute(
    _input: ProcessWagerInput,
    _options?: ProcessWagerOptions,
  ): Promise<ProcessWagerResult> {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  }
}

let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let processWager: ProcessWagerTransactionUseCase;
let client: SQSClient;
const createdQueues: string[] = [];

beforeAll(async () => {
  Logger.overrideLogger(["error"]);
  orm = await MikroORM.init(config);
  await orm.migrator.up();
  createWallet = new CreateWalletUseCase(orm);
  processWager = new ProcessWagerTransactionUseCase(orm);
  const base = consumerOptionsFromEnv();
  client = new SQSClient({ region: base.region, endpoint: base.endpoint });
});

afterAll(async () => {
  for (const queueUrl of createdQueues) {
    await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  }
  client.destroy();
  await orm.close(true);
});

async function newConsumer(
  useCase: ProcessWagerTransactionUseCase,
  overrides: Partial<SqsWagerConsumerOptions> = {},
) {
  const suffix = newId();
  const consumer = new SqsWagerConsumer(useCase, {
    ...consumerOptionsFromEnv(),
    queueName: `test-wagers-${suffix}.fifo`,
    deadLetterQueueName: `test-wagers-dlq-${suffix}.fifo`,
    waitTimeSeconds: 1,
    ...overrides,
  });
  const urls = await consumer.queueUrls();
  createdQueues.push(urls.queueUrl, urls.deadLetterQueueUrl);
  return { consumer, ...urls };
}

function wagerMessage(wallet: Wallet, amount = "25.00") {
  const externalTransactionId = `bet-${newId()}`;
  return {
    messageId: `msg-${newId()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
  };
}

async function send(queueUrl: string, body: unknown, groupId = "group-1") {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: newId(),
    }),
  );
}

async function messagesIn(queueUrl: string): Promise<number> {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return (
    Number(result.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

async function debitsOf(walletId: string): Promise<number> {
  return (await ledgerOf(orm, walletId)).filter((entry) => entry.direction === "DEBIT").length;
}

function openWallet() {
  return createWallet.execute({
    playerId: newId(),
    initialBalance: { amount: "100.00", currency: "BRL" },
  });
}

describe("Consumidor SQS", () => {
  test("processa a mensagem com o mesmo use case do HTTP, grava a inbox e confirma", async () => {
    const wallet = await openWallet();
    const { consumer, queueUrl } = await newConsumer(processWager);
    const message = wagerMessage(wallet);
    await send(queueUrl, message);

    expect(await consumer.pollOnce()).toEqual(["processed"]);
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await messagesIn(queueUrl)).toBe(0);

    const rows = (await orm.em.fork().execute(
      "select processed_at from inbox_messages where consumer_name = ? and message_id = ?",
      [CONSUMER_NAME, message.messageId],
    )) as { processed_at: Date | null }[];
    expect(rows[0]?.processed_at).not.toBeNull();
    consumer.destroy();
  });

  test("reentrega da mesma mensagem é confirmada sem efeito (worker morto depois do commit e antes do ack)", async () => {
    const wallet = await openWallet();
    const { consumer, queueUrl } = await newConsumer(processWager);
    const message = wagerMessage(wallet);
    const { idempotencyKey, ...data } = message.data;

    // A instância anterior processou e fez commit, mas morreu antes de confirmar na fila.
    await processWager.execute(
      { ...data, idempotencyKey, correlationId: message.messageId },
      {
        inbox: InboxMessage.receive({
          consumerName: CONSUMER_NAME,
          messageId: message.messageId,
          payloadHash: payloadHash(message.data),
          receivedAt: new Date(),
        }),
      },
    );
    await send(queueUrl, message);

    expect(await consumer.pollOnce()).toEqual(["duplicate"]);
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await messagesIn(queueUrl)).toBe(0);
    consumer.destroy();
  });

  test("erro de negócio é terminal: a mensagem é confirmada e não volta", async () => {
    const wallet = await openWallet();
    const { consumer, queueUrl } = await newConsumer(processWager);
    const message = wagerMessage(wallet);
    message.data.walletId = newId();

    await send(queueUrl, message);

    expect(await consumer.pollOnce()).toEqual(["business-error"]);
    expect(await messagesIn(queueUrl)).toBe(0);
    consumer.destroy();
  });

  test("mensagem malformada vai direto para a DLQ", async () => {
    const { consumer, queueUrl, deadLetterQueueUrl } = await newConsumer(processWager);

    await send(queueUrl, { not: "a wager message" });

    expect(await consumer.pollOnce()).toEqual(["dead-lettered"]);
    expect(await messagesIn(queueUrl)).toBe(0);
    expect(await messagesIn(deadLetterQueueUrl)).toBe(1);
    consumer.destroy();
  });

  test(
    "falha transitória não confirma: a mensagem volta e, esgotadas as tentativas, vai para a DLQ",
    async () => {
      const wallet = await openWallet();
      const { consumer, queueUrl, deadLetterQueueUrl } = await newConsumer(
        new UnavailableUseCase(orm),
        { maxReceiveCount: 2, retryBaseSeconds: 1 },
      );
      await send(queueUrl, wagerMessage(wallet));

      expect(await consumer.pollOnce()).toEqual(["retry"]);
      expect(await messagesIn(queueUrl)).toBe(1);

      await Bun.sleep(1_200);
      expect(await consumer.pollOnce()).toEqual(["retry"]);

      await Bun.sleep(2_200);
      await consumer.pollOnce();
      const dead = await client.send(
        new ReceiveMessageCommand({ QueueUrl: deadLetterQueueUrl, WaitTimeSeconds: 1 }),
      );
      expect(dead.Messages ?? []).toHaveLength(1);
      expect(await debitsOf(wallet.id)).toBe(0);
      consumer.destroy();
    },
    20_000,
  );
});
