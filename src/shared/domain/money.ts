import Decimal from "decimal.js";

const MoneyDecimal = Decimal.clone({ precision: 34})

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
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

  toString(): string {
    return this.value.toFixed(2);
  }
}