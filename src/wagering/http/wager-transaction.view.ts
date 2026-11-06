import { WagerTransaction } from "../domain/wager-transaction";

export function toWagerTransactionView(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId || null,
    gameId: transaction.gameId || null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}