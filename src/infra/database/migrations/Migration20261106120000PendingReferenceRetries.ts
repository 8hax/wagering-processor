import { Migration } from "@mikro-orm/migrations";

/** Controle de reprocessamento das transações em PENDING_REFERENCE (backoff e limite de tentativas). */
export class Migration20261106120000PendingReferenceRetries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0 check (reference_attempts >= 0),
        add column next_reference_attempt_at timestamptz;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop column if exists next_reference_attempt_at,
        drop column if exists reference_attempts;
    `);
  }
}
