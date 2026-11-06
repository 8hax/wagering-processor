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
