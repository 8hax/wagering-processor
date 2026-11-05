import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../../src/infra/database/mikro-orm.config";
import { newId } from "../../../src/shared/infra/ids";
import { ProcessWagerTransactionUseCase } from "../../../src/wagering/application/process-wager-transaction.use-case";

const [walletId, playerId, betsText] = process.argv.slice(2);
if (!walletId || !playerId || !betsText) {
  throw new Error("usage: bet-worker <walletId> <playerId> <numberOfBets>");
}

const orm = await MikroORM.init(config);
const useCase = new ProcessWagerTransactionUseCase(orm);

try {
  const results = await Promise.all(
    Array.from({ length: Number(betsText) }, () => {
      const externalTransactionId = `worker-${newId()}`;
      return useCase.execute({
        idempotencyKey: `provider-a:${externalTransactionId}`,
        correlationId: newId(),
        providerId: "provider-a",
        externalTransactionId,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      });
    }),
  );
  console.log(JSON.stringify(results.map((result) => result.status)));
} finally {
  await orm.close(true);
}