import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { isUniqueViolation } from "../../infra/database/postgres-errors";
import { Money, MoneyProps } from "../../shared/domain/money";
import { newId } from "../../shared/infra/ids";
import { Wallet } from "../domain/wallet";
import { insertLedgerEntry, insertOpeningTransaction, insertWallet } from "../infra/wallet.sql";
import { WalletAlreadyExistsError } from "./wallet.errors";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: input.playerId,
      initialBalance: Money.from(input.initialBalance),
      openingTransactionId: newId(),
      openingEntryId: newId(),
      now: new Date(),
    });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        await insertWallet(em, wallet);
        if (openingEntry) {
          await insertOpeningTransaction(em, wallet, openingEntry);
          await insertLedgerEntry(em, openingEntry);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, "wallets_player_currency_unique")) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }

    return wallet;
  }
}