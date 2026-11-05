import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { parseInput } from "../../shared/http/parse-input";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { GetWalletUseCase } from "../application/get-wallet.use-case";
import { Wallet } from "../domain/wallet";

const MoneyBodySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

const CreateWalletBodySchema = z.object({
  playerId: z.uuid(),
  initialBalance: MoneyBodySchema,
});

const WalletIdSchema = z.object({ walletId: z.uuid() });

@Controller("wallets")
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    const input = parseInput(CreateWalletBodySchema, body);
    const wallet = await this.createWallet.execute(input);
    return toWalletResponse(wallet);
  }

  @Get(":walletId")
  async findOne(@Param("walletId") walletId: string) {
    const { walletId: id } = parseInput(WalletIdSchema, { walletId });
    const wallet = await this.getWallet.execute(id);
    return toWalletResponse(wallet);
  }
}

function toWalletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}