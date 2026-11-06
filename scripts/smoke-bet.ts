const BASE_URL = "http://localhost:3000";

async function call(
  label: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`\n${label}\n  ${method} ${path} → ${response.status}\n  ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const playerId = Bun.randomUUIDv7();
const run = playerId.slice(-8);

const wallet = await call("0) criar carteira com 100.00 (esperado: 201)", "POST", "/wallets", {
  playerId,
  initialBalance: { amount: "100.00", currency: "BRL" },
});

const bet = (externalTransactionId: string, amount: string, kind = "BET") => ({
  providerId: "provider-a",
  externalTransactionId,
  playerId,
  walletId: wallet.id,
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind,
  money: { amount, currency: "BRL" },
});

const key = (id: string) => ({ "idempotency-key": `provider-a:${id}` });

await call("1) aposta de 80.00 (esperado: 201, PROCESSED, saldo 20.00)",
  "POST", "/wagering/transactions", bet(`bet-1-${run}`, "80.00"), key(`bet-1-${run}`));

await call("2) a MESMA aposta de novo (esperado: 200, idempotentReplay true, saldo 20.00)",
  "POST", "/wagering/transactions", bet(`bet-1-${run}`, "80.00"), key(`bet-1-${run}`));

await call("3) mesma chave, valor diferente (esperado: 409, IDEMPOTENCY_CONFLICT)",
  "POST", "/wagering/transactions", bet(`bet-1-${run}`, "50.00"), key(`bet-1-${run}`));

await call("4) nova aposta de 80.00 sem saldo (esperado: 422, REJECTED, INSUFFICIENT_FUNDS)",
  "POST", "/wagering/transactions", bet(`bet-2-${run}`, "80.00"), key(`bet-2-${run}`));

await call("5a) uma WIN de 10.00 (esperado: 201, PROCESSED, saldo 30.00)",
  "POST", "/wagering/transactions", bet(`win-1-${run}`, "10.00", "WIN"), key(`win-1-${run}`));

await call("5b) uma LOSS (esperado: 201, PROCESSED, saldo continua 30.00)",
  "POST", "/wagering/transactions", bet(`loss-1-${run}`, "0.00", "LOSS"), key(`loss-1-${run}`));

await call("5c) REFUND da aposta 1 (esperado: 201, PROCESSED, saldo 110.00)",
  "POST", "/wagering/transactions",
  { ...bet(`refund-1-${run}`, "80.00", "REFUND"), referenceExternalTransactionId: `bet-1-${run}` },
  key(`refund-1-${run}`));

await call("5d) outro REFUND da mesma aposta (esperado: 422, REFERENCE_ALREADY_REVERSED)",
  "POST", "/wagering/transactions",
  { ...bet(`refund-2-${run}`, "80.00", "REFUND"), referenceExternalTransactionId: `bet-1-${run}` },
  key(`refund-2-${run}`));

await call("5e) REFUND de uma aposta que ainda não chegou (esperado: 202, PENDING_REFERENCE)",
  "POST", "/wagering/transactions",
  { ...bet(`refund-3-${run}`, "10.00", "REFUND"), referenceExternalTransactionId: `bet-futura-${run}` },
  key(`refund-3-${run}`));

await call("6) sem Idempotency-Key (esperado: 400, INVALID_PAYLOAD)",
  "POST", "/wagering/transactions", bet(`bet-3-${run}`, "10.00"));

await call("7) consultar a carteira (esperado: 200, saldo 110.00, versão 4)",
  "GET", `/wallets/${wallet.id}`);