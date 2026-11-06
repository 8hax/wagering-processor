import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "../../src/infra/database/mikro-orm.config";
import { newId } from "../../src/shared/infra/ids";

/**
 * Reversibilidade das migrations: aplica, reverte e reaplica todas em um schema vazio e isolado,
 * sem tocar no schema usado pelos outros testes.
 */
const schema = `migration_test_${newId().replaceAll("-", "")}`;
const TABLES = ["wallets", "wallet_ledger_entries", "wager_transactions", "outbox_messages", "inbox_messages"];

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  await orm.em.fork().execute(`create schema ${schema}`);
});

afterAll(async () => {
  await orm.em.fork().execute(`drop schema if exists ${schema} cascade`);
  await orm.close(true);
});

async function tablesInSchema(): Promise<string[]> {
  const rows = (await orm.em
    .fork()
    .execute("select table_name from information_schema.tables where table_schema = ?", [schema])) as {
    table_name: string;
  }[];
  return rows.map((row) => row.table_name).filter((name) => TABLES.includes(name)).sort();
}

async function indexesInSchema(): Promise<string[]> {
  const rows = (await orm.em
    .fork()
    .execute("select indexname from pg_indexes where schemaname = ?", [schema])) as { indexname: string }[];
  return rows.map((row) => row.indexname).sort();
}

describe("Migrations", () => {
  test("todas aplicam, revertem e reaplicam em um schema vazio, chegando ao mesmo resultado", async () => {
    const total = (await orm.migrator.getPending({ schema })).length;
    expect(total).toBeGreaterThan(0);

    const applied = await orm.migrator.up({ schema });
    expect(applied).toHaveLength(total);
    expect(await tablesInSchema()).toEqual([...TABLES].sort());
    const indexesAfterFirstUp = await indexesInSchema();
    expect(indexesAfterFirstUp).toContain("wager_tx_one_reversal_per_reference");

    const reverted = await orm.migrator.down({ schema, to: 0 });
    expect(reverted).toHaveLength(total);
    expect(await tablesInSchema()).toEqual([]);

    await orm.migrator.up({ schema });
    expect(await tablesInSchema()).toEqual([...TABLES].sort());
    expect(await indexesInSchema()).toEqual(indexesAfterFirstUp);
  });
});
