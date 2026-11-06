import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";

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

/**
 * Taxonomia de recusas. Todas são terminais e legíveis por máquina:
 * - INSUFFICIENT_FUNDS: aposta sem saldo (o provedor desiste);
 * - REVERSAL_INSUFFICIENT_FUNDS: reversão que deixaria o saldo negativo (exige ação operacional);
 * - REFERENCE_NOT_FOUND: a referência não apareceu dentro do limite de tentativas;
 * - REFERENCE_MISMATCH: a referência é de outro jogador, carteira, moeda ou rodada;
 * - REFERENCE_NOT_PROCESSED: a referência existe, mas não foi aplicada (ex.: foi recusada);
 * - INVALID_REFERENCE_KIND: REFUND só reverte BET; ROLLBACK reverte BET, WIN ou REFUND;
 * - AMOUNT_MISMATCH: reversão parcial não é suportada;
 * - REFERENCE_ALREADY_REVERSED: a referência já foi revertida (por REFUND ou ROLLBACK; só uma vez).
 */
export type FailureCode =
  | "INSUFFICIENT_FUNDS"
  | "REVERSAL_INSUFFICIENT_FUNDS"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_MISMATCH"
  | "REFERENCE_NOT_PROCESSED"
  | "INVALID_REFERENCE_KIND"
  | "AMOUNT_MISMATCH"
  | "REFERENCE_ALREADY_REVERSED";

const REVERSIBLE_KINDS: Readonly<Record<string, readonly WagerTransactionKind[]>> = {
  REFUND: ["BET"] as WagerTransactionKind[],
  ROLLBACK: ["BET", "WIN", "REFUND"] as WagerTransactionKind[],
};

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
    super(`transaction in status ${status} cannot make this transition`);
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
  referenceTransactionId: string | undefined;
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
    private _referenceTransactionId: string | undefined,
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
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
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

  markProcessed(observedBalance: Money, at: Date, referenceTransactionId?: string): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date, referenceTransactionId?: string): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = at;
  }

  /** A referência ainda não existe: a transação aguarda e será reprocessada. Só a partir de PENDING. */
  markPendingReference(observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
  }

  /**
   * Valida a transação referenciada por um REFUND ou ROLLBACK.
   * Devolve o código de recusa, ou undefined quando a referência é válida.
   */
  referenceProblem(reference: WagerTransaction): FailureCode | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return "REFERENCE_MISMATCH";
    }
    if (!(REVERSIBLE_KINDS[this.kind] ?? []).includes(reference.kind)) {
      return "INVALID_REFERENCE_KIND";
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return "REFERENCE_NOT_PROCESSED";
    }
    if (!reference.money.equals(this.money)) {
      return "AMOUNT_MISMATCH";
    }
    return undefined;
  }

  /**
   * Direção do lançamento no extrato. LOSS não movimenta saldo.
   * REFUND devolve a aposta (crédito); ROLLBACK inverte o efeito da referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        const original = reference?.ledgerDirectionFor();
        if (original === undefined) {
          throw new InvalidWagerTransactionError("ROLLBACK requires a reference that moved the balance");
        }
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      default:
        return undefined;
    }
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