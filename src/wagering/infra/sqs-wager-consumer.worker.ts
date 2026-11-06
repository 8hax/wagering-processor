import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../application/process-wager-transaction.use-case";
import { SqsWagerConsumer } from "./sqs-wager-consumer";

/**
 * Laço do consumidor SQS. Em SIGTERM (enableShutdownHooks), para de buscar mensagens,
 * termina a mensagem em andamento e devolve a visibilidade das que ainda não foram tratadas.
 */
@Injectable()
export class SqsWagerConsumerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SqsWagerConsumerWorker.name);
  private readonly consumer: SqsWagerConsumer;
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(processWager: ProcessWagerTransactionUseCase) {
    this.consumer = new SqsWagerConsumer(processWager);
  }

  onApplicationBootstrap(): void {
    if (process.env.WAGER_CONSUMER_ENABLED === "false") {
      this.logger.log("wager consumer disabled");
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
    this.consumer.destroy();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.consumer.pollOnce(() => !this.running);
      } catch (error) {
        this.logger.error(
          "wager consumer iteration failed",
          error instanceof Error ? error.stack : undefined,
        );
        await Bun.sleep(1000);
      }
    }
  }
}
