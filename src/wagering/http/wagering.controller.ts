import { Body, Controller, Headers, Post, Res } from "@nestjs/common";
import { z } from "zod";
import { parseInput } from "../../shared/http/parse-input";
import { newId } from "../../shared/infra/ids";
import {
  ProcessWagerResult,
  ProcessWagerTransactionUseCase,
} from "../application/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../domain/wager-transaction";

const HeadersSchema = z.object({
  idempotencyKey: z.string().min(1).max(255),
  correlationId: z.string().min(1).max(100).optional(),
});

const WagerBodySchema = z.object({
  providerId: z.string().min(1).max(100),
  externalTransactionId: z.string().min(1).max(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(200),
  gameId: z.string().min(1).max(200),
  kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: z.object({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: z.string().min(1).max(200).optional(),
});

interface StatusSettable {
  status(code: number): unknown;
}

@Controller("wagering/transactions")
export class WageringController {
  constructor(private readonly processWager: ProcessWagerTransactionUseCase) {}

  @Post()
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusSettable,
  ) {
    const headers = parseInput(HeadersSchema, { idempotencyKey, correlationId });
    const input = parseInput(WagerBodySchema, body);

    const result = await this.processWager.execute({
      ...input,
      idempotencyKey: headers.idempotencyKey,
      correlationId: headers.correlationId ?? newId(),
    });

    response.status(statusFor(result));
    return result;
  }
}

function statusFor(result: ProcessWagerResult): number {
  if (result.status === WagerTransactionStatus.Rejected) {
    return 422;
  }
  return result.idempotentReplay ? 200 : 201;
}