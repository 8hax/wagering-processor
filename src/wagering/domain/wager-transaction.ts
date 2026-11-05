import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export type FailureCode = "INSUFFICIENT_FUNDS";

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class InvalidWagerTransactionError extends DomainError {
  override readonly code = "INVALID_WAGER_TRANSACTION";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  override readonly code = "INVALID_TRANSACTION_STATE";

  constructor(status: WagerTransactionStatus) {
    super(`transaction in terminal status ${status} cannot change`);
  }
}

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends WagerTransactionProps {
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  observedBalance: Money | undefined;
  processedAt: Date | undefined;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private constructor(
    props: WagerTransactionProps,
    private _status: WagerTransactionStatus,
    private _failureCode: FailureCode | undefined,
    private _observedBalance: Money | undefined,
    private _processedAt: Date | undefined,
  ) {
    this.id = props.id;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.walletId = props.walletId;
    this.playerId = props.playerId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.money = props.money;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    this.createdAt = props.createdAt;
  }

  static create(props: WagerTransactionProps): WagerTransaction {
    const transaction = new WagerTransaction(
      props,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
    );

    if (transaction.requiresReference() && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (transaction.affectsBalance() && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError("amount must be positive");
    }
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state,
      state.status,
      state.failureCode,
      state.observedBalance,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(observedBalance: Money, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status);
    }
  }
}