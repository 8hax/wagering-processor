import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../../shared/application/cursor";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { findLedgerPage, findWalletById } from "../infra/wallet.sql";
import { WalletNotFoundError } from "./wallet.errors";

export interface LedgerPage {
  walletId: string;
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

@Injectable()
export class ListWalletLedgerUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const em = this.orm.em.fork();

    if (!(await findWalletById(em, walletId))) {
      throw new WalletNotFoundError();
    }

    const after = cursor === undefined ? undefined : decodeCursor(cursor);

    let entries: WalletLedgerEntry[];
    try {
      entries = await findLedgerPage(em, walletId, after, limit + 1);
    } catch (error) {
      if (after) {
        throw new InvalidCursorError();
      }
      throw error;
    }

    const hasMore = entries.length > limit;
    const items = hasMore ? entries.slice(0, limit) : entries;
    const last = items.at(-1);

    return {
      walletId,
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }
}