import { MikroORM } from "@mikro-orm/postgresql";
import { Global, Module, OnApplicationShutdown } from "@nestjs/common";
import config from "./mikro-orm.config";

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: () => MikroORM.init(config),
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}