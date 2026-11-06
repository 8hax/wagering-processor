import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable, Logger } from "@nestjs/common";
import { MoneyProps } from "../../shared/domain/money";
import { readReconciliationSnapshot } from "../infra/wallet.sql";
import { WalletNotFoundError } from "./wallet.errors";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(private readonly orm: MikroORM) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await readReconciliationSnapshot(this.orm.em.fork(), walletId);
    if (!snapshot) {
      throw new WalletNotFoundError();
    }

    const difference = snapshot.stored.subtract(snapshot.calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.logger.warn(
        JSON.stringify({
          event: "wallet_reconciliation_divergence",
          walletId,
          difference: difference.toString(),
          checkedEntries: snapshot.checkedEntries,
        }),
      );
    }

    return {
      walletId,
      storedBalance: snapshot.stored.toJSON(),
      calculatedBalance: snapshot.calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}