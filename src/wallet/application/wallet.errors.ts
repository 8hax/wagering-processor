import { DomainError } from "../../shared/domain/domain-error";

export class WalletNotFoundError extends DomainError {
  override readonly code = "WALLET_NOT_FOUND";

  constructor() {
    super("wallet not found");
  }
}

export class WalletAlreadyExistsError extends DomainError {
  override readonly code = "WALLET_ALREADY_EXISTS";

  constructor() {
    super("a wallet already exists for this player and currency");
  }
}

export class ConcurrentWalletUpdateError extends DomainError {
  override readonly code = "CONCURRENT_WALLET_UPDATE";

  constructor() {
    super("wallet was modified concurrently, retry the operation");
  }
}