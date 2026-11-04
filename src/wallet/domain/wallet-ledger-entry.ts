import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export class InvalidLedgerEntryError extends DomainError {
  override readonly code = "INVALID_LEDGER_ENTRY";

  constructor(message: string) {
    super(message);
  }
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);

    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError("ledger entry amount must be positive");
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("ledger entry cannot produce a negative balance");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError("ledger entry arithmetic does not balance");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expectedAfter =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedAfter.equals(this.balanceAfter);
  }
}