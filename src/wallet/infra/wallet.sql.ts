import { EntityManager } from "@mikro-orm/postgresql";
import { payloadHash } from "../../shared/application/payload-hash";
import { Money } from "../../shared/domain/money";
import { Wallet } from "../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ConcurrentWalletUpdateError } from "../application/wallet.errors";


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

export async function updateWalletBalance(
  em: EntityManager,
  wallet: Wallet,
  previousVersion: number,
): Promise<void> {
  const result = (await em.execute(
    `update wallets
       set balance = ?, version = ?, updated_at = ?
     where id = ? and version = ?`,
    [
      wallet.balance.toString(),
      wallet.version,
      wallet.updatedAt,
      wallet.id,
      previousVersion,
    ],
    "run",
  )) as { affectedRows: number };

  if (result.affectedRows !== 1) {
    throw new ConcurrentWalletUpdateError();
  }
}

interface ReconciliationRow {
  currency: string;
  stored: string;
  credits: string;
  debits: string;
  checked: string | number;
}

export interface ReconciliationSnapshot {
  stored: Money;
  calculated: Money;
  checkedEntries: number;
}

export async function readReconciliationSnapshot(
  em: EntityManager,
  walletId: string,
): Promise<ReconciliationSnapshot | undefined> {
  const rows = (await em.execute(
    `select w.currency,
            w.balance::text as stored,
            round(coalesce(sum(e.amount) filter (where e.direction = 'CREDIT'), 0), 2)::text as credits,
            round(coalesce(sum(e.amount) filter (where e.direction = 'DEBIT'), 0), 2)::text as debits,
            count(e.id) as checked
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [walletId],
  )) as ReconciliationRow[];

  const row = rows[0];
  if (!row) {
    return undefined;
  }

  const credits = Money.from({ amount: row.credits, currency: row.currency });
  const debits = Money.from({ amount: row.debits, currency: row.currency });

  return {
    stored: Money.from({ amount: row.stored, currency: row.currency }),
    calculated: credits.subtract(debits),
    checkedEntries: Number(row.checked),
  };
}

interface LedgerEntryRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

const LEDGER_COLUMNS = `
  id, wallet_id, transaction_id, direction, amount::text as amount, currency,
  balance_before::text as balance_before, balance_after::text as balance_after, created_at`;

function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: row.currency });
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balance_before),
    balanceAfter: money(row.balance_after),
    createdAt: new Date(row.created_at),
  });
}

export async function findLedgerPage(
  em: EntityManager,
  walletId: string,
  after: { createdAt: string; id: string } | undefined,
  limit: number,
): Promise<WalletLedgerEntry[]> {
  const rows = after
    ? ((await em.execute(
        `select ${LEDGER_COLUMNS} from wallet_ledger_entries
          where wallet_id = ? and (created_at, id) > (?::timestamptz, ?::uuid)
          order by created_at, id
          limit ?`,
        [walletId, after.createdAt, after.id, limit],
      )) as LedgerEntryRow[])
    : ((await em.execute(
        `select ${LEDGER_COLUMNS} from wallet_ledger_entries
          where wallet_id = ?
          order by created_at, id
          limit ?`,
        [walletId, limit],
      )) as LedgerEntryRow[]);

  return rows.map(toLedgerEntry);
}