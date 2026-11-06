import { IntegrationEvent } from "../application/integration-event";
import { DomainError } from "./domain-error";

export class OutboxMessageAlreadyPublishedError extends DomainError {
  override readonly code = "OUTBOX_MESSAGE_ALREADY_PUBLISHED";

  constructor(id: string) {
    super(`outbox message ${id} was already published`);
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/** Primeira espera após uma falha; dobra a cada nova falha. */
export const OUTBOX_BASE_RETRY_DELAY_MS = 1_000;
/** Teto da espera: o evento nunca é descartado, só espera no máximo isso entre tentativas. */
export const OUTBOX_MAX_RETRY_DELAY_MS = 5 * 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
    this._publishedAt = at;
  }

  /** Registra uma falha e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
    const delay = Math.min(
      OUTBOX_BASE_RETRY_DELAY_MS * 2 ** this._attempts,
      OUTBOX_MAX_RETRY_DELAY_MS,
    );
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
