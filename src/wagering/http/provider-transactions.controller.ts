import { Controller, Get, Param } from "@nestjs/common";
import { z } from "zod";
import { parseInput } from "../../shared/http/parse-input";
import { GetWagerTransactionUseCase } from "../application/get-wager-transaction.use-case";
import { toWagerTransactionView } from "./wager-transaction.view";

const ProviderReferenceSchema = z.object({
  providerId: z.string().min(1).max(100),
  externalTransactionId: z.string().min(1).max(200),
});

@Controller("providers/:providerId/wagering/transactions")
export class ProviderTransactionsController {
  constructor(private readonly getWagerTransaction: GetWagerTransactionUseCase) {}

  @Get(":externalTransactionId")
  async findOne(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const reference = parseInput(ProviderReferenceSchema, { providerId, externalTransactionId });
    const transaction = await this.getWagerTransaction.byProviderReference(
      reference.providerId,
      reference.externalTransactionId,
    );
    return toWagerTransactionView(transaction);
  }
}