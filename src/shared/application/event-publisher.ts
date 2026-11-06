import { OutboxMessage } from "../domain/outbox-message";

/**
 * Porta de publicação de eventos de integração.
 * A implementação real envia para o SQS; o domínio e o publicador da outbox não conhecem o SQS.
 */
export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
  /** Verifica se o broker está alcançável (usado pelo readiness). */
  abstract ping(): Promise<void>;
}
