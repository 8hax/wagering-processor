import { Module } from "@nestjs/common";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { ProviderTransactionsController } from "./http/provider-transactions.controller";
import { WageringController } from "./http/wagering.controller";
import { PendingReferenceWorker } from "./infra/pending-reference.worker";
import { SqsWagerConsumerWorker } from "./infra/sqs-wager-consumer.worker";

@Module({
  controllers: [WageringController, ProviderTransactionsController],
  providers: [
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    SqsWagerConsumerWorker,
    PendingReferenceWorker,
  ],
})
export class WageringModule {}