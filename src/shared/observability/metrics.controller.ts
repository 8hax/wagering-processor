import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, Header } from "@nestjs/common";
import {
  metricsRegistry,
  outboxOldestPendingAgeSeconds,
  outboxPendingMessages,
} from "./metrics";

interface OutboxStatsRow {
  pending: string | number;
  oldest_age_seconds: string | number;
}

@Controller("metrics")
export class MetricsController {
  constructor(private readonly orm: MikroORM) {}

  @Get()
  @Header("Content-Type", metricsRegistry.contentType)
  async metrics(): Promise<string> {
    const rows = (await this.orm.em.fork().execute(
      `select count(*) as pending,
              coalesce(extract(epoch from now() - min(occurred_at)), 0) as oldest_age_seconds
         from outbox_messages
        where published_at is null`,
    )) as OutboxStatsRow[];

    const stats = rows[0];
    outboxPendingMessages.set(Number(stats?.pending ?? 0));
    outboxOldestPendingAgeSeconds.set(Number(stats?.oldest_age_seconds ?? 0));

    return metricsRegistry.metrics();
  }
}