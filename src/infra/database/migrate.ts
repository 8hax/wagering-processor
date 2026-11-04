import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

const direction = process.argv[2] ?? "up";
const orm = await MikroORM.init(config);

try {
  if (direction === "down") {
    await orm.migrator.down();
  } else {
    await orm.migrator.up();
  }
} finally {
  await orm.close(true);
}