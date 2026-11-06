import "reflect-metadata";
import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { HttpErrorFilter } from "./shared/http/http-error.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true, flattenParams: true }),
  });
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();