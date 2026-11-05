import { DomainError } from "../../shared/domain/domain-error";

export class IdempotencyConflictError extends DomainError {
  override readonly code = "IDEMPOTENCY_CONFLICT";

  constructor() {
    super("idempotency key was already used with a different payload");
  }
}

export class WalletMismatchError extends DomainError {
  override readonly code = "WALLET_MISMATCH";

  constructor() {
    super("wallet does not belong to this player or does not use this currency");
  }
}

export class UnsupportedTransactionKindError extends DomainError {
  override readonly code = "UNSUPPORTED_TRANSACTION_KIND";

  constructor(kind: string) {
    super(`transaction kind ${kind} is not supported yet`);
  }
}