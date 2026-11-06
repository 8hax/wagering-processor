import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { EventPublisher } from "../shared/application/event-publisher";

type CheckStatus = "up" | "down";

@Controller("health")
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly eventPublisher: EventPublisher,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const [database, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().execute("select 1")),
      this.check(() => this.eventPublisher.ping()),
    ]);
    const checks = { database, sqs };

    if (database === "down" || sqs === "down") {
      throw new ServiceUnavailableException({ status: "unavailable", checks });
    }
    return { status: "ok", checks };
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await probe();
      return "up";
    } catch {
      return "down";
    }
  }
}
