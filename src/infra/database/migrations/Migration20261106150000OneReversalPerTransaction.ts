import { Migration } from "@mikro-orm/migrations";

/**
 * Uma transação pode ser revertida no máximo UMA vez, qualquer que seja o tipo da reversão.
 * O índice anterior era por (referência, tipo): permitia um REFUND e um ROLLBACK da mesma BET,
 * creditando o valor da aposta duas vezes.
 */
export class Migration20261106150000OneReversalPerTransaction extends Migration {
  override async up(): Promise<void> {
    this.addSql(`drop index if exists wager_tx_one_reversal_per_kind;`);
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists wager_tx_one_reversal_per_reference;`);
    this.addSql(`
      create unique index wager_tx_one_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }
}
