import { DomainError } from "../../shared/domain/domain-error";
import { CurrencyMismatchError, Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export class InsufficientFundsError extends DomainError {
  override readonly code = "INSUFFICIENT_FUNDS";

  constructor() {
    super("wallet balance is insufficient for this debit");
  }
}

export class InvalidWalletOperationError extends DomainError {
  override readonly code = "INVALID_WALLET_OPERATION";

  constructor(message: string) {
    super(message);
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface WalletMovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError("initial balance cannot be negative");
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );

    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(props.initialBalance.currency),
      balanceAfter: props.initialBalance,
      createdAt: props.now,
    });

    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertValidMovement(props.money);

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError();
    }

    return this.applyMovement(
      LedgerDirection.Debit,
      this._balance.subtract(props.money),
      props,
    );
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertValidMovement(props.money);

    return this.applyMovement(
      LedgerDirection.Credit,
      this._balance.add(props.money),
      props,
    );
  }

  private applyMovement(
    direction: LedgerDirection,
    newBalance: Money,
    props: WalletMovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: props.at,
    });

    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = props.at;

    return entry;
  }

  private assertValidMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError("movement amount must be positive");
    }
  }
}