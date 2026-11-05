import { Migration } from "@mikro-orm/migrations";

export class Migration20261105090000TransactionsOutboxInbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wallets
        add constraint wallets_id_player_currency_unique unique (id, player_id, currency);
    `);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        provider_id                        text           not null,
        external_transaction_id            text           not null,
        idempotency_key                    text           not null,
        payload_hash                       char(64)       not null,
        wallet_id                          uuid           not null,
        player_id                          uuid           not null,
        round_id                           text,
        game_id                            text,
        kind                               text           not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(19, 2) not null check (amount >= 0),
        currency                           char(3)        not null,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid           references wager_transactions (id),
        status                             text           not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        observed_balance                   numeric(19, 2),
        created_at                         timestamptz    not null,
        processed_at                       timestamptz,

        constraint wager_tx_idempotency_key_unique
          unique (idempotency_key),
        constraint wager_tx_provider_external_unique
          unique (provider_id, external_transaction_id),
        constraint wager_tx_id_wallet_unique
          unique (id, wallet_id),
        constraint wager_tx_wallet_player_currency_fk
          foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency),
        constraint wager_tx_round_and_game_required
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_tx_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_failure_code_iff_rejected_or_failed
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_iff_terminal
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null))
      );
    `);

    this.addSql(`
      create unique index wager_tx_one_reversal_per_kind
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (created_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create function forbid_terminal_transaction_change() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal and cannot change', old.id;
        end if;
        return new;
      end;
      $$;
    `);

    this.addSql(`
      create trigger wager_transactions_terminal_is_final
        before update on wager_transactions
        for each row execute function forbid_terminal_transaction_change();
    `);

    this.addSql(`
      alter table wallet_ledger_entries
        add constraint ledger_transaction_wallet_fk
        foreign key (transaction_id, wallet_id)
        references wager_transactions (id, wallet_id);
    `);

    this.addSql(`
      create table outbox_messages (
        id               uuid         primary key,
        aggregate_id     uuid         not null,
        event_type       text         not null,
        payload          jsonb        not null,
        occurred_at      timestamptz  not null,
        attempts         integer      not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz
      );
    `);

    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (occurred_at)
        where published_at is null;
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name  text         not null,
        message_id     text         not null,
        payload_hash   char(64)     not null,
        received_at    timestamptz  not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`alter table wallet_ledger_entries drop constraint if exists ledger_transaction_wallet_fk;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop function if exists forbid_terminal_transaction_change();`);
    this.addSql(`alter table wallets drop constraint if exists wallets_id_player_currency_unique;`);
  }
}