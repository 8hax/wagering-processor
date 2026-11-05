import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../../src/shared/domain/money";
import { newId } from "../../../src/shared/infra/ids";
import { ProcessWagerInput } from "../../../src/wagering/application/process-wager-transaction.use-case";
import { Wallet } from "../../../src/wallet/domain/wallet";

interface LedgerRow {
  direction: string;
  amount: string;
}

export async function ledgerOf(orm: MikroORM, walletId: string): Promise<LedgerRow[]> {
  return (await orm.em.fork().execute(
    `select direction, amount::text as amount
       from wallet_ledger_entries
      where wallet_id = ?
      order by created_at, id`,
    [walletId],
  )) as LedgerRow[];
}

export function reconstructBalance(entries: LedgerRow[], currency: string): Money {
  return entries.reduce((total, entry) => {
    const amount = Money.from({ amount: entry.amount, currency });
    return entry.direction === "CREDIT" ? total.add(amount) : total.subtract(amount);
  }, Money.zero(currency));
}

export function betInput(wallet: Wallet, externalTransactionId: string, amount: string): ProcessWagerInput {
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    correlationId: newId(),
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}