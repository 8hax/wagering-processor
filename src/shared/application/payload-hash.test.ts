import { describe, expect, test } from "bun:test";
import { canonicalJson, payloadHash } from "./payload-hash";

describe("payloadHash", () => {
  test("a ordem das chaves não altera o hash", () => {
    const a = { kind: "BET", money: { amount: "25.00", currency: "BRL" } };
    const b = { money: { currency: "BRL", amount: "25.00" }, kind: "BET" };

    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  test("um valor diferente altera o hash", () => {
    const a = { money: { amount: "25.00", currency: "BRL" } };
    const b = { money: { amount: "25.01", currency: "BRL" } };

    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });

  test("ignora chaves com valor undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("gera 64 caracteres hexadecimais", () => {
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});