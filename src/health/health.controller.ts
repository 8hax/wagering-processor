import { MikroORM } from "@mikro-orm/postgresql";
import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";

@Controller("health")
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    try {
      await this.orm.em.fork().execute("select 1");
    } catch {
      throw new ServiceUnavailableException({
        status: "unavailable",
        checks: { database: "down" },
      });
    }
    return { status: "ok", checks: { database: "up" } };
  }
}