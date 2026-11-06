import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migration20261104120000InitialSchema } from "./migrations/Migration20261104120000InitialSchema";
import { Migration20261105090000TransactionsOutboxInbox } from "./migrations/Migration20261105090000TransactionsOutboxInbox";
import { Migration20261106120000PendingReferenceRetries } from "./migrations/Migration20261106120000PendingReferenceRetries";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing environment variable: ${name}`);
  }
  return value;
}

export default defineConfig({
  host: requireEnv("DB_HOST"),
  port: Number(requireEnv("DB_PORT")),
  dbName: requireEnv("DB_NAME"),
  user: requireEnv("DB_USER"),
  password: requireEnv("DB_PASSWORD"),
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      Migration20261104120000InitialSchema,
      Migration20261105090000TransactionsOutboxInbox,
      Migration20261106120000PendingReferenceRetries,
    ],
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },
});