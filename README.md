# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas enviadas por provedores de jogos, mantendo a carteira de cada jogador e um extrato (ledger) auditável e imutável. O sistema permanece correto com requisições **duplicadas** e **simultâneas**, inclusive entre **múltiplas instâncias** da aplicação.

As decisões técnicas, os trade-offs e o que ficou fora do escopo estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime, gerenciador de pacotes e testes | Bun 1.4 |
| Linguagem | TypeScript em modo estrito |
| Framework | NestJS 12 |
| Banco | PostgreSQL 17 |
| ORM e migrations | MikroORM 7 |
| Dinheiro | decimal.js |
| Validação de entrada | Zod |
| Mensageria | AWS SQS (FIFO), emulado pelo MiniStack |
| Métricas | prom-client (formato Prometheus) |
| Orquestração local | Docker Compose |

## Pré-requisitos

- [Docker](https://docs.docker.com/engine/install/) com o plugin `docker compose`
- [Bun](https://bun.sh) 1.4 ou superior

## Como executar

```bash
# 1. Dependências
bun install

# 2. Variáveis de ambiente (o Bun carrega o .env automaticamente)
cp .env.example .env

# 3. PostgreSQL e SQS (MiniStack)
docker compose up -d
docker compose ps          # aguarde o Postgres ficar (healthy)

# 4. Migrations
bun run migration:up

# 5. Aplicação (porta 3000 por padrão; altere com PORT=...)
bun run dev
```

Para desfazer a última migration: `bun run migration:down`.

A aplicação inicia dois processos em segundo plano, ambos com as filas criadas automaticamente:

- o **consumidor** da fila `wager-transactions.fifo`, que processa as mensagens `WagerTransactionRequested` com o mesmo use case da API HTTP (DLQ: `wager-transactions-dlq.fifo`). Desligável com `WAGER_CONSUMER_ENABLED=false`;
- o **publicador da outbox**, que publica os eventos de integração na fila `wagering-events.fifo`. Desligável com `OUTBOX_PUBLISHER_ENABLED=false`;
- o **worker de referências pendentes**, que tenta de novo, com backoff, os `REFUND`/`ROLLBACK` que chegaram antes da transação referenciada. Desligável com `PENDING_REFERENCE_WORKER_ENABLED=false`.

O MiniStack foi escolhido no lugar do LocalStack porque não exige conta nem token.

## Testes

```bash
bun run typecheck          # verificação de tipos
bun run test:unit          # domínio puro, sem banco
bun run test:integration   # contra o PostgreSQL e o SQS reais (requer o passo 3)
bun test                   # todos
```

Os testes de integração aplicam as migrations automaticamente e criam carteiras próprias a cada execução, sem limpar o banco (o extrato é imutável por trigger). Eles cobrem:

- o cenário obrigatório: duas apostas de `80.00` sobre saldo de `100.00`;
- `WIN` creditando o saldo e `LOSS` registrada sem alterar saldo, versão ou extrato;
- `REFUND` e `ROLLBACK`: cada transação é revertida uma única vez, qualquer que seja o tipo da reversão (inclusive com reversões em paralelo), valor, tipo ou rodada divergentes recusados, e reversão que deixaria saldo negativo recusada;
- `REFUND` antes da `BET`: fica `PENDING_REFERENCE` e é aplicado quando a aposta chega, ou recusado com `REFERENCE_NOT_FOUND` quando as tentativas se esgotam;
- a mesma aposta enviada 50 vezes em paralelo, resultando em um único débito;
- 20 apostas disputando a mesma carteira;
- carteiras distintas processadas em paralelo;
- **3 processos separados** apostando na mesma carteira;
- conflito de idempotência, atomicidade com a outbox e constraints do banco;
- consumo da fila com inbox: reentrega após commit sem efeito duplicado, erro de negócio confirmado, mensagem malformada na DLQ e falha transitória com retry até a DLQ;
- publicação da outbox no SQS, **dois publishers concorrentes** sobre a mesma outbox, instância que morre com eventos reivindicados e retry com backoff após falha do broker;
- extrato paginado, consultas e reconciliação;
- todas as migrations aplicadas, revertidas e reaplicadas em um schema vazio e isolado.

Os testes de operações financeiras verificam a invariante `saldo da carteira == saldo reconstruído pelo extrato`.

### Verificação manual

Com a aplicação rodando, o script abaixo executa o fluxo completo pela API (criação de carteira, aposta, replay, conflito, saldo insuficiente, `WIN`, `LOSS`, `REFUND`, reversão duplicada e `REFUND` fora de ordem) e imprime cada resposta:

```bash
bun scripts/smoke-bet.ts
```

### Teste de carga

Com a aplicação rodando, o script abaixo dispara requisições concorrentes pela API em três cenários (muitas carteiras em paralelo, uma carteira muito disputada e a mesma aposta reenviada 200 vezes), imprime vazão, latência (p50, p95, p99) e status, e confere ao final a correção de cada cenário pela reconciliação. Termina com erro se alguma verificação falhar.

```bash
bun scripts/load-test.ts                 # CONCURRENCY=100 bun scripts/load-test.ts para mais pressão
```

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria uma carteira (saldo inicial gera uma transação `OPENING`) |
| `GET` | `/wallets/:walletId` | Consulta a carteira |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Extrato paginado por cursor (limite padrão 50, máximo 100) |
| `POST` | `/wallets/:walletId/reconciliation` | Compara o saldo com a soma do extrato |
| `POST` | `/wagering/transactions` | Submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET` | `/health/live` | O processo está vivo |
| `GET` | `/health/ready` | O PostgreSQL e o SQS estão alcançáveis |
| `GET` | `/metrics` | Métricas no formato Prometheus |

### Exemplo

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da carteira>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Valores monetários são sempre strings com duas casas decimais (`"25.00"`).

### Status HTTP

| Situação | Status | Código (`code`) | O provedor deve |
|---|---|---|---|
| Transação nova processada | `201` | — | — |
| Replay de transação já processada | `200` | `idempotentReplay: true` (uma recusa repetida volta como `422`, e uma pendência como `202`) | — |
| Reversão aguardando a transação referenciada | `202` | `status: PENDING_REFERENCE` | consultar depois |
| Payload inválido | `400` | `INVALID_PAYLOAD`, `INVALID_MONEY`, `INVALID_CURSOR` | corrigir o payload |
| Recurso inexistente | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | verificar o identificador |
| Conflito | `409` | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` | não reenviar |
| Rejeição por regra de negócio | `422` | `INSUFFICIENT_FUNDS`, `WALLET_MISMATCH`, `CURRENCY_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND` | desistir |
| Falha transitória de infraestrutura | `503` | `SERVICE_UNAVAILABLE`, `CONCURRENT_WALLET_UPDATE` | reenviar mais tarde |

## Escopo desta entrega

**Implementado:** `Money`, carteira e extrato imutável; criação de carteira com transação `OPENING`; operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` com lock por carteira, idempotência persistente e Transactional Outbox com publicador concorrente no SQS (retry com backoff); reversões fora de ordem (`PENDING_REFERENCE`) com worker de retry e prazo; consumidor SQS com inbox na mesma transação, retry e DLQ; reconciliação; extrato paginado; consultas de transação; logs estruturados em JSON, métricas e health checks; ponto de extensão para autenticação.

**Fora do escopo:** as limitações conhecidas e o que faria a seguir estão no `ARCHITECTURE.md`.

## Estrutura

```
src/
├── shared/       Money, erros de domínio, eventos, HTTP e observabilidade compartilhados
├── wallet/       carteira e extrato        (domain · application · infra · http)
├── wagering/     transações de aposta      (domain · application · infra · http)
├── health/       liveness e readiness
└── infra/        conexão com o banco e migrations
test/integration/ testes contra o PostgreSQL real
scripts/          verificação manual e teste de carga pela API
```

O domínio (`domain/`) não depende do NestJS nem do banco.

## Uso de IA

Este projeto foi desenvolvido com o apoio do Claude (Anthropic), usado de três formas:

- **Estudo:** explicações dos conceitos envolvidos (lock pessimista, idempotência, Transactional Outbox, inbox, SQS FIFO, reversões) e simulados de perguntas técnicas.
- **Implementação:** boa parte do código foi gerada pela IA e entregue em incrementos. Cada incremento foi revisado, aplicado e executado por mim, sempre com a suíte de testes passando antes do commit.
- **Revisão:** auditorias do código contra os requisitos do desafio, que encontraram problemas reais, como a possibilidade de reverter a mesma aposta por um `REFUND` e por um `ROLLBACK`, corrigida com teste e migration (D16).

As decisões registradas no `ARCHITECTURE.md` foram escritas por mim e revisadas com a IA. Usar IA não muda a minha responsabilidade sobre o projeto: as escolhas e as limitações documentadas são minhas, e posso explicar e defender cada uma.
