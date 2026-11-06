import { EntityManager } from "@mikro-orm/postgresql";
import { InboxMessage } from "../domain/inbox-message";

export const INBOX_PRIMARY_KEY = "inbox_messages_pkey";

/** Grava o registro da mensagem. Uma reentrega viola a chave primária e desfaz a transação. */
export async function insertInboxMessage(em: EntityManager, message: InboxMessage): Promise<void> {
  await em.execute(
    `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
     values (?, ?, ?, ?, ?)`,
    [
      message.consumerName,
      message.messageId,
      message.payloadHash,
      message.receivedAt,
      message.processedAt ?? null,
    ],
  );
}

/** Impressão digital gravada para a mensagem, ou undefined se ela não estiver na inbox. */
export async function findInboxPayloadHash(
  em: EntityManager,
  consumerName: string,
  messageId: string,
): Promise<string | undefined> {
  const rows = (await em.execute(
    `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
    [consumerName, messageId],
  )) as { payload_hash: string }[];
  return rows[0]?.payload_hash;
}
