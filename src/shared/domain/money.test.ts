import { describe, expect, test } from "bun:test";
import { InvalidMoneyError, Money, MoneyProps } from "./money";

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

  test.each(["", "abc", "NaN", "Infinity", "1e3", "25.001", "-25.00", "25", "25.5", "100000000000000000.00"])(
    "rejeita amount inválido: %p",
    (amount) => {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    },
  );
  
   test.each(["brl", "REAL", "" ])(
    "rejeita currency inválida: %p",
    (currency: string) => {
      expect(() => Money.from({ amount: "10.00", currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );


  test("rejeita amount que chega como number em tempo de execução", () => {
    const props = { amount: 25.55, currency: "BRL" } as unknown as MoneyProps;

    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

    test("aceita o valor máximo de 17 dígitos inteiros", () => {
    const money = Money.from({ amount: "99999999999999999.99", currency: "BRL" });

    expect(money.toString()).toBe("99999999999999999.99");
  });

});