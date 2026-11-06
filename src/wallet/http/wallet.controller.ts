import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { parseInput } from "../../shared/http/parse-input";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { GetWalletUseCase } from "../application/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "../application/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet.use-case";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ProviderAuthGuard } from "../../shared/http/provider-auth.guard";

const MoneyBodySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

const CreateWalletBodySchema = z.object({
  playerId: z.uuid(),
  initialBalance: MoneyBodySchema,
});

const WalletIdSchema = z.object({ walletId: z.uuid() });

const LedgerQuerySchema = z.object({
  walletId: z.uuid(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@UseGuards(ProviderAuthGuard)
@Controller("wallets")
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly listWalletLedger: ListWalletLedgerUseCase,
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

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    const query = parseInput(LedgerQuerySchema, { walletId, cursor, limit });
    const page = await this.listWalletLedger.execute(query.walletId, query.cursor, query.limit);
    return {
      walletId: page.walletId,
      items: page.items.map(toLedgerEntryView),
      nextCursor: page.nextCursor,
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    const { walletId: id } = parseInput(WalletIdSchema, { walletId });
    return this.reconcileWallet.execute(id);
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

function toLedgerEntryView(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}