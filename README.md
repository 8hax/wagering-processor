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

A aplicação já inicia o **publicador da outbox**, que publica os eventos de integração na fila FIFO `wagering-events.fifo` (criada automaticamente). Ele pode ser desligado com `OUTBOX_PUBLISHER_ENABLED=false`. O MiniStack foi escolhido no lugar do LocalStack porque não exige conta nem token.

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
- a mesma aposta enviada 50 vezes em paralelo, resultando em um único débito;
- 20 apostas disputando a mesma carteira;
- carteiras distintas processadas em paralelo;
- **3 processos separados** apostando na mesma carteira;
- conflito de idempotência, atomicidade com a outbox e constraints do banco;
- publicação da outbox no SQS, **dois publishers concorrentes** sobre a mesma outbox, instância que morre com eventos reivindicados e retry com backoff após falha do broker;
- extrato paginado, consultas e reconciliação.

Todos verificam a invariante `saldo da carteira == saldo reconstruído pelo extrato`.

### Verificação manual

Com a aplicação rodando, o script abaixo executa o fluxo completo pela API (criação de carteira, aposta, replay, conflito, saldo insuficiente, `WIN`, `LOSS` e `REFUND` não suportado) e imprime cada resposta:

```bash
bun scripts/smoke-bet.ts
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
| Replay de transação já processada | `200` | `idempotentReplay: true` | — |
| Payload inválido | `400` | `INVALID_PAYLOAD`, `INVALID_MONEY`, `INVALID_CURSOR` | corrigir o payload |
| Recurso inexistente | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | verificar o identificador |
| Conflito | `409` | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` | não reenviar |
| Rejeição por regra de negócio | `422` | `INSUFFICIENT_FUNDS`, `WALLET_MISMATCH`, `CURRENCY_MISMATCH` | desistir |
| Tipo de operação não implementado (`REFUND`, `ROLLBACK`) | `501` | `UNSUPPORTED_TRANSACTION_KIND` | — |
| Falha transitória de infraestrutura | `503` | `SERVICE_UNAVAILABLE`, `CONCURRENT_WALLET_UPDATE` | reenviar mais tarde |

## Escopo desta entrega

**Implementado:** `Money`, carteira e extrato imutável; criação de carteira com transação `OPENING`; operações `BET`, `WIN` e `LOSS` com lock por carteira, idempotência persistente e Transactional Outbox com publicador concorrente no SQS (retry com backoff); reconciliação; extrato paginado; consultas de transação; logs estruturados em JSON, métricas e health checks; ponto de extensão para autenticação.

**Não implementado:** `REFUND` e `ROLLBACK` (recusadas com `501`), o consumidor SQS de entrada (com inbox), a DLQ e o reprocessamento de `PENDING_REFERENCE`. O schema já contempla essas partes, e o desenho de cada uma está descrito no `ARCHITECTURE.md`.

## Estrutura

```
src/
├── shared/       Money, erros de domínio, eventos, HTTP e observabilidade compartilhados
├── wallet/       carteira e extrato        (domain · application · infra · http)
├── wagering/     transações de aposta      (domain · application · infra · http)
├── health/       liveness e readiness
└── infra/        conexão com o banco e migrations
test/integration/ testes contra o PostgreSQL real
scripts/          verificação manual pela API
```

O domínio (`domain/`) não depende do NestJS nem do banco.
