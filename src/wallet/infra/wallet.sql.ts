import { EntityManager } from "@mikro-orm/postgresql";
import { payloadHash } from "../../shared/application/payload-hash";
import { Money } from "../../shared/domain/money";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const WALLET_COLUMNS =
  "id, player_id, currency, balance::text as balance, version, created_at, updated_at";

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

export async function findWalletById(
  em: EntityManager,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Wallet | undefined> {
  const lock = options.forUpdate ? " for update" : "";
  const rows = (await em.execute(
    `select ${WALLET_COLUMNS} from wallets where id = ?${lock}`,
    [id],
  )) as WalletRow[];
  const row = rows[0];
  return row ? toWallet(row) : undefined;
}

export async function insertWallet(em: EntityManager, wallet: Wallet): Promise<void> {
  await em.execute(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      wallet.id,
      wallet.playerId,
      wallet.currency,
      wallet.balance.toString(),
      wallet.version,
      wallet.createdAt,
      wallet.updatedAt,
    ],
  );
}

export async function insertOpeningTransaction(
  em: EntityManager,
  wallet: Wallet,
  entry: WalletLedgerEntry,
): Promise<void> {
  await em.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, kind, amount, currency, status,
        observed_balance, created_at, processed_at)
     values (?, 'internal', ?, ?, ?, ?, ?, 'OPENING', ?, ?, 'PROCESSED', ?, ?, ?)`,
    [
      entry.transactionId,
      `opening:${wallet.id}`,
      `internal:opening:${wallet.id}`,
      payloadHash({ walletId: wallet.id, money: entry.money.toJSON() }),
      wallet.id,
      wallet.playerId,
      entry.money.toString(),
      entry.money.currency,
      entry.balanceAfter.toString(),
      entry.createdAt,
      entry.createdAt,
    ],
  );
}

export async function insertLedgerEntry(
  em: EntityManager,
  entry: WalletLedgerEntry,
): Promise<void> {
  await em.execute(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.walletId,
      entry.transactionId,
      entry.direction,
      entry.money.toString(),
      entry.money.currency,
      entry.balanceBefore.toString(),
      entry.balanceAfter.toString(),
      entry.createdAt,
    ],
  );
}