import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction.use-case";

/**
 * Worker agendado que reprocessa transações em PENDING_REFERENCE (REFUND/ROLLBACK que chegaram
 * antes da transação referenciada). Roda em todas as instâncias; o FOR UPDATE SKIP LOCKED
 * garante que cada pendência seja tratada por uma única instância por vez.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly processWager: ProcessWagerTransactionUseCase) {}

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === "false") {
      this.logger.log("pending reference worker disabled");
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    const idleMs = Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1000);
    while (this.running) {
      try {
        const outcome = await this.processWager.retryPendingReference();
        if (outcome !== undefined) {
          continue;
        }
      } catch (error) {
        this.logger.error(
          "pending reference iteration failed",
          error instanceof Error ? error.stack : undefined,
        );
      }
      await Bun.sleep(idleMs);
    }
  }
}
