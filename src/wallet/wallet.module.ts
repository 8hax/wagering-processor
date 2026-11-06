import { Module } from "@nestjs/common";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { GetWalletUseCase } from "./application/get-wallet.use-case";
import { WalletController } from "./http/wallet.controller";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";

@Module({
  controllers: [WalletController],
  providers: [CreateWalletUseCase, GetWalletUseCase, ReconcileWalletUseCase],
})
export class WalletModule {}