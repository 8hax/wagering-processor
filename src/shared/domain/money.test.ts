import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  MoneyProps,
} from "./money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test("cria a partir de uma string com 2 casas decimais", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });

    expect(money.toString()).toBe("25.00");
    expect(money.currency).toBe("BRL");
  });

  test("aceita zero", () => {
    const money = Money.from({ amount: "0.00", currency: "BRL" });

    expect(money.toString()).toBe("0.00");
  });

  test("aceita o valor máximo de 17 dígitos inteiros", () => {
    const money = Money.from({ amount: "99999999999999999.99", currency: "BRL" });

    expect(money.toString()).toBe("99999999999999999.99");
  });

  test.each([
    "",
    "abc",
    "NaN",
    "Infinity",
    "1e3",
    "25.001",
    "-25.00",
    "25",
    "25.5",
    "100000000000000000.00",
  ])("rejeita amount inválido: %p", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(["brl", "REAL", ""])(
    "rejeita currency inválida: %p",
    (currency) => {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  test("rejeita amount que chega como number em tempo de execução", () => {
    const props = { amount: 25.55, currency: "BRL" } as unknown as MoneyProps;

    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });
});

describe("Money.zero", () => {
  test("cria um valor zero na moeda informada", () => {
    const zero = Money.zero("BRL");

    expect(zero.toString()).toBe("0.00");
    expect(zero.isZero()).toBe(true);
  });

  test("rejeita moeda inválida", () => {
    expect(() => Money.zero("brl")).toThrow(InvalidMoneyError);
  });
});

describe("Money.add", () => {
  test("soma dois valores", () => {
    expect(brl("10.00").add(brl("2.50")).toString()).toBe("12.50");
  });

  test("é exato onde o number falharia: 0.10 + 0.20 = 0.30", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("não altera o valor original (imutabilidade)", () => {
    const aposta = brl("25.00");

    aposta.add(brl("10.00"));

    expect(aposta.toString()).toBe("25.00");
  });

  test("rejeita moedas diferentes", () => {
    expect(() => brl("10.00").add(usd("10.00"))).toThrow(CurrencyMismatchError);
  });
});

describe("Money.subtract e negate", () => {
  
  test("subtrai dois valores", () => {
    expect(brl("100.00").subtract(brl("25.00")).toString()).toBe("75.00");
  });

  test("subtração pode produzir um valor negativo", () => {
    const resultado = brl("10.00").subtract(brl("25.00"));

    expect(resultado.toString()).toBe("-15.00");
    expect(resultado.isNegative()).toBe(true);
  });

  test("subtract rejeita moedas diferentes", () => {
    expect(() => brl("10.00").subtract(usd("10.00"))).toThrow(
      CurrencyMismatchError,
    );
  });

  test("negate inverte o sinal", () => {
    expect(brl("25.00").negate().toString()).toBe("-25.00");
  });

  test("negate de zero continua sendo 0.00, nunca -0.00", () => {
    const zeroNegado = Money.zero("BRL").negate();

    expect(zeroNegado.toString()).toBe("0.00");
    expect(zeroNegado.isNegative()).toBe(false);
  });
});

describe("Money.isLessThan", () => {

  test("é verdadeiro quando o valor é menor", () => {
    expect(brl("10.00").isLessThan(brl("25.00"))).toBe(true);
  });

  test("é falso quando os valores são iguais", () => {
    expect(brl("100.00").isLessThan(brl("100.00"))).toBe(false);
  });

  test("rejeita moedas diferentes", () => {
    expect(() => brl("10.00").isLessThan(usd("25.00"))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe("Money: consultas e serialização", () => {
  test("isPositive é falso para zero", () => {
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
  });

  test("equals compara valor e moeda", () => {
    expect(brl("25.00").equals(brl("25.00"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
    expect(brl("25.00").equals(usd("25.00"))).toBe(false);
  });

  test("toJSON devolve o formato do contrato", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(JSON.stringify(brl("25.00"))).toBe(
      '{"amount":"25.00","currency":"BRL"}',
    );
  });
});