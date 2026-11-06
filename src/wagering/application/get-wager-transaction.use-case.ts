import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { WagerTransaction } from "../domain/wager-transaction";
import {
  findWagerTransactionById,
  findWagerTransactionByProviderReference,
} from "../infra/wager-transaction.sql";
import { WagerTransactionNotFoundError } from "./wagering.errors";

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(private readonly orm: MikroORM) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await findWagerTransactionById(this.orm.em.fork(), transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError();
    }
    return transaction;
  }

  async byProviderReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await findWagerTransactionByProviderReference(
      this.orm.em.fork(),
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError();
    }
    return transaction;
  }
}