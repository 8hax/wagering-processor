import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { DatabaseModule } from "./infra/database/database.module";
import { WalletModule } from "./wallet/wallet.module";
import { WageringModule } from "./wagering/wagering.module";

@Module({
  imports: [DatabaseModule, HealthModule, WalletModule, WageringModule],
})
export class AppModule {}