import { Module } from "@nestjs/common";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { ProviderTransactionsController } from "./http/provider-transactions.controller";
import { WageringController } from "./http/wagering.controller";

@Module({
  controllers: [WageringController, ProviderTransactionsController],
  providers: [ProcessWagerTransactionUseCase, GetWagerTransactionUseCase],
})
export class WageringModule {}