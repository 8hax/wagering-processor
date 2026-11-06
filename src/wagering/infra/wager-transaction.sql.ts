import { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../shared/domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";

interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string | null;
  game_id: string | null;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

const COLUMNS = `
  id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount::text as amount, currency,
  reference_external_transaction_id, status, failure_code,
  observed_balance::text as observed_balance, created_at, processed_at`;

function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id ?? "",
    gameId: row.game_id ?? "",
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: new Date(row.created_at),
    status: row.status as WagerTransactionStatus,
    failureCode: (row.failure_code as FailureCode | null) ?? undefined,
    observedBalance:
      row.observed_balance === null
        ? undefined
        : Money.from({ amount: row.observed_balance, currency: row.currency }),
    processedAt: row.processed_at === null ? undefined : new Date(row.processed_at),
  });
}

export async function insertWagerTransaction(
  em: EntityManager,
  transaction: WagerTransaction,
): Promise<void> {
  await em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        reference_external_transaction_id, status, failure_code,
        observed_balance, created_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.idempotencyKey,
      transaction.payloadHash,
      transaction.walletId,
      transaction.playerId,
      transaction.roundId,
      transaction.gameId,
      transaction.kind,
      transaction.money.toString(),
      transaction.money.currency,
      transaction.referenceExternalTransactionId ?? null,
      transaction.status,
      transaction.failureCode ?? null,
      transaction.observedBalance?.toString() ?? null,
      transaction.createdAt,
      transaction.processedAt ?? null,
    ],
  );
}

export async function findWagerTransactionByIdempotencyKey(
  em: EntityManager,
  idempotencyKey: string,
): Promise<WagerTransaction | undefined> {
  const rows = (await em.execute(
    `select ${COLUMNS} from wager_transactions where idempotency_key = ?`,
    [idempotencyKey],
  )) as WagerTransactionRow[];
  const row = rows[0];
  return row ? toWagerTransaction(row) : undefined;
}

export async function findWagerTransactionById(
  em: EntityManager,
  id: string,
): Promise<WagerTransaction | undefined> {
  const rows = (await em.execute(
    `select ${COLUMNS} from wager_transactions where id = ?`,
    [id],
  )) as WagerTransactionRow[];
  const row = rows[0];
  return row ? toWagerTransaction(row) : undefined;
}

export async function findWagerTransactionByProviderReference(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTransaction | undefined> {
  const rows = (await em.execute(
    `select ${COLUMNS} from wager_transactions
      where provider_id = ? and external_transaction_id = ?`,
    [providerId, externalTransactionId],
  )) as WagerTransactionRow[];
  const row = rows[0];
  return row ? toWagerTransaction(row) : undefined;
}