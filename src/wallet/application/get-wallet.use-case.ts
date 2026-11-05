import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { Wallet } from "../domain/wallet";
import { findWalletById } from "../infra/wallet.sql";
import { WalletNotFoundError } from "./wallet.errors";

@Injectable()
export class GetWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await findWalletById(this.orm.em.fork(), walletId);
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    return wallet;
  }
}