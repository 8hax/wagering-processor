/**
 * Teste de carga simples pela API HTTP, sem dependências externas.
 *
 * Uso (com a aplicação rodando):  bun scripts/load-test.ts
 * Variáveis opcionais: BASE_URL (padrão http://localhost:3000) e CONCURRENCY (padrão 50).
 *
 * Três cenários, cada um com verificação de correção ao final:
 *   A) muitas carteiras em paralelo (vazão);
 *   B) uma carteira muito disputada (pior caso do lock pessimista);
 *   C) a mesma aposta reenviada muitas vezes ao mesmo tempo (idempotência).
 * Termina com código 1 se alguma verificação falhar.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const run = Bun.randomUUIDv7().slice(-8);

interface Sample {
  status: number;
  ms: number;
}

interface Wallet {
  id: string;
  playerId: string;
}

let failures = 0;

function check(condition: boolean, message: string): void {
  console.log(`  ${condition ? "OK  " : "FALHA"} ${message}`);
  if (!condition) {
    failures += 1;
  }
}

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function openWallet(amount: string): Promise<Wallet> {
  const playerId = Bun.randomUUIDv7();
  const { status, body } = await request("POST", "/wallets", {
    playerId,
    initialBalance: { amount, currency: "BRL" },
  });
  if (status !== 201) {
    throw new Error(`could not create wallet: ${status}`);
  }
  return { id: body.id, playerId };
}

function bet(wallet: Wallet, externalTransactionId: string, amount: string) {
  return {
    body: {
      providerId: "provider-load",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${run}`,
      gameId: "load-test",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
    headers: { "idempotency-key": `provider-load:${externalTransactionId}` },
  };
}

/** Executa as tarefas com no máximo CONCURRENCY requisições simultâneas. */
async function runPool(tasks: (() => Promise<number>)[]): Promise<{ samples: Sample[]; seconds: number }> {
  const samples: Sample[] = [];
  let next = 0;
  const started = performance.now();

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (!task) {
        return;
      }
      const t0 = performance.now();
      const status = await task();
      samples.push({ status, ms: performance.now() - t0 });
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return { samples, seconds: (performance.now() - started) / 1000 };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function report(samples: Sample[], seconds: number): Record<number, number> {
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const byStatus: Record<number, number> = {};
  for (const sample of samples) {
    byStatus[sample.status] = (byStatus[sample.status] ?? 0) + 1;
  }
  console.log(
    `  ${samples.length} requisições em ${seconds.toFixed(2)}s ` +
      `(${(samples.length / seconds).toFixed(0)} req/s) | latência ms: ` +
      `p50 ${percentile(latencies, 50).toFixed(1)}, p95 ${percentile(latencies, 95).toFixed(1)}, ` +
      `p99 ${percentile(latencies, 99).toFixed(1)}, máx ${(latencies.at(-1) ?? 0).toFixed(1)}`,
  );
  console.log(`  status: ${JSON.stringify(byStatus)}`);
  return byStatus;
}

async function expectConsistent(wallet: Wallet, expectedBalance: string): Promise<void> {
  const { body } = await request("POST", `/wallets/${wallet.id}/reconciliation`);
  check(body?.consistent === true, "saldo == saldo reconstruído pelo extrato (reconciliação)");
  check(
    body?.storedBalance?.amount === expectedBalance,
    `saldo final ${body?.storedBalance?.amount} (esperado ${expectedBalance})`,
  );
}

async function scenarioManyWallets(): Promise<void> {
  const walletCount = 50;
  const betsPerWallet = 20;
  console.log(`\nA) ${walletCount} carteiras, ${betsPerWallet} apostas de 1.00 cada, em paralelo`);

  const wallets = await Promise.all(Array.from({ length: walletCount }, () => openWallet("100.00")));
  const tasks = wallets.flatMap((wallet, w) =>
    Array.from({ length: betsPerWallet }, (_, i) => async () => {
      const { body, headers } = bet(wallet, `a-${run}-${w}-${i}`, "1.00");
      return (await request("POST", "/wagering/transactions", body, headers)).status;
    }),
  );

  const { samples, seconds } = await runPool(tasks);
  const byStatus = report(samples, seconds);
  check(byStatus[201] === walletCount * betsPerWallet, "todas as apostas processadas (201)");
  for (const wallet of wallets.slice(0, 5)) {
    await expectConsistent(wallet, "80.00");
  }
}

async function scenarioHotWallet(): Promise<void> {
  const bets = 300;
  console.log(`\nB) 1 carteira com 100.00 recebendo ${bets} apostas de 1.00 ao mesmo tempo`);

  const wallet = await openWallet("100.00");
  const tasks = Array.from({ length: bets }, (_, i) => async () => {
    const { body, headers } = bet(wallet, `b-${run}-${i}`, "1.00");
    return (await request("POST", "/wagering/transactions", body, headers)).status;
  });

  const { samples, seconds } = await runPool(tasks);
  const byStatus = report(samples, seconds);
  check(byStatus[201] === 100, "exatamente 100 apostas aceitas (201)");
  check(byStatus[422] === bets - 100, `exatamente ${bets - 100} recusadas por saldo (422)`);
  await expectConsistent(wallet, "0.00");
}

async function scenarioDuplicates(): Promise<void> {
  const copies = 200;
  console.log(`\nC) a mesma aposta de 10.00 enviada ${copies} vezes ao mesmo tempo`);

  const wallet = await openWallet("100.00");
  const { body, headers } = bet(wallet, `c-${run}`, "10.00");
  const tasks = Array.from({ length: copies }, () => async () =>
    (await request("POST", "/wagering/transactions", body, headers)).status,
  );

  const { samples, seconds } = await runPool(tasks);
  const byStatus = report(samples, seconds);
  check(byStatus[201] === 1, "exatamente 1 processamento (201)");
  check(byStatus[200] === copies - 1, `${copies - 1} replays (200)`);
  await expectConsistent(wallet, "90.00");
}

console.log(`Teste de carga contra ${BASE_URL} (concorrência ${CONCURRENCY})`);
await scenarioManyWallets();
await scenarioHotWallet();
await scenarioDuplicates();

console.log(failures === 0 ? "\nTodas as verificações passaram." : `\n${failures} verificação(ões) falharam.`);
process.exit(failures === 0 ? 0 : 1);
