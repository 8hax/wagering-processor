import Decimal from "decimal.js";
import { DomainError } from "./domain-error";

const MoneyDecimal = Decimal.clone({ precision: 34 });

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  override readonly code = "INVALID_MONEY";

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  override readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== "string" || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        "amount must be a non-negative decimal string with exactly 2 decimal places",
      );
    }
    if (typeof props.currency !== "string" || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(
        "currency must be a 3-letter uppercase ISO-4217 code",
      );
    }
    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

    toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    if (this.value.isZero()) {
      return "0.00";
    }
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}