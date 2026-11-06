import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { OutboxPublisher } from "../application/outbox-publisher";

const BATCH_SIZE = 50;

/**
 * Laço em segundo plano que drena a outbox. Roda em todas as instâncias:
 * o SKIP LOCKED garante que elas dividem o trabalho sem publicar a mesma mensagem ao mesmo tempo.
 * No desligamento, para de buscar lotes novos e espera o lote em andamento terminar.
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly outboxPublisher: OutboxPublisher) {}

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === "false") {
      this.logger.log("outbox publisher disabled");
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
    const idleMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
    while (this.running) {
      try {
        const result = await this.outboxPublisher.publishBatch(BATCH_SIZE);
        if (result.claimed === BATCH_SIZE) {
          continue;
        }
      } catch (error) {
        this.logger.error(
          "outbox publisher iteration failed",
          error instanceof Error ? error.stack : undefined,
        );
      }
      await Bun.sleep(idleMs);
    }
  }
}
