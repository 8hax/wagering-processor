import { DomainError } from "./domain-error";

export class InboxMessageAlreadyProcessedError extends DomainError {
  override readonly code = "INBOX_MESSAGE_ALREADY_PROCESSED";

  constructor(messageId: string) {
    super(`inbox message ${messageId} was already processed`);
  }
}

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

/**
 * Registro de uma mensagem recebida da fila. A chave (consumerName, messageId) é única no banco:
 * gravar o registro na mesma transação do efeito financeiro garante que uma reentrega
 * da mesma mensagem nunca seja aplicada duas vezes.
 */
export class InboxMessage {
  private constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: Omit<InboxMessageState, "processedAt">): InboxMessage {
    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError(this.messageId);
    }
    this._processedAt = at;
  }
}
