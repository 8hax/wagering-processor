import { Migration } from "@mikro-orm/migrations";

export class Migration20261104120000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   uuid           not null,
        currency    char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19, 2) not null check (balance >= 0),
        version     integer        not null check (version >= 1),
        created_at  timestamptz    not null,
        updated_at  timestamptz    not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_id_currency_unique unique (id, currency)
      );
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       text           not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(19, 2) not null check (amount > 0),
        currency        char(3)        not null,
        balance_before  numeric(19, 2) not null check (balance_before >= 0),
        balance_after   numeric(19, 2) not null check (balance_after >= 0),
        created_at      timestamptz    not null,
        constraint ledger_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ledger_one_entry_per_transaction_per_wallet
          unique (transaction_id, wallet_id),
        constraint ledger_entry_is_balanced check (
          (direction = 'DEBIT'  and balance_after = balance_before - amount) or
          (direction = 'CREDIT' and balance_after = balance_before + amount)
        )
      );
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_cursor_idx
        on wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      create function forbid_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop function if exists forbid_ledger_mutation();`);
    this.addSql(`drop table if exists wallets;`);
  }
}