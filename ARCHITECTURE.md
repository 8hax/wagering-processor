# Arquitetura — Distributed Wagering Processor

## 1. Visão geral

O Distributed Wagering Processor é um serviço financeiro que processa as transações de apostas enviadas por provedores de jogos: `BET` (aposta), `WIN` (prêmio), `LOSS` (perda), `REFUND` (devolução) e `ROLLBACK` (desfazimento). Ele mantém a carteira de cada jogador e um extrato imutável, em que todo saldo pode ser reconstruído a partir dos lançamentos. Os valores monetários são representados por um objeto de valor próprio (`Money`), que trafega como string e é calculado com decimal, sem nunca passar por `number`, para evitar erros de arredondamento. As regras críticas, como saldo não negativo e extrato imutável, são garantidas também por constraints e triggers no PostgreSQL, como última camada de defesa.

O foco do projeto é permanecer correto diante de requisições duplicadas, simultâneas e distribuídas entre várias instâncias. A idempotência persistente garante que uma mesma operação tenha um único efeito, devolvendo a resposta original em caso de reenvio. O lock pessimista por carteira serializa as operações da mesma carteira, enquanto carteiras diferentes são processadas em paralelo. Os eventos são publicados no SQS FIFO pelo padrão Transactional Outbox, sem risco de perda entre a operação financeira e a publicação, e as transações também podem chegar pela fila, por um consumidor com inbox, retry e DLQ. A entrega inclui 114 testes, que exercitam a concorrência contra o PostgreSQL e o SQS reais (inclusive com 3 processos separados disputando a mesma carteira), além de logs estruturados, métricas no formato Prometheus e health checks.

As decisões e seus trade-offs estão na seção 2, o que ficou fora do escopo na seção 3 e as limitações conhecidas na seção 4. As instruções de execução estão no `README.md`.

## 2. Diário de decisões

### D1 — Versão fixa do PostgreSQL (17-alpine)

A imagem do banco é fixada em uma versão principal específica, em vez de `postgres:latest`. Com `latest`, o ambiente pode mudar sem nenhuma alteração no projeto: basta uma nova versão ser publicada entre o desenvolvimento e a avaliação para que o avaliador execute um banco diferente do que foi testado.

O risco é concreto: os arquivos de dados de uma versão principal do PostgreSQL não são compatíveis com outra. Se `latest` passasse da 17 para a 18, o container novo não conseguiria abrir o volume criado pela versão anterior e não iniciaria. A variante `alpine` foi escolhida por gerar uma imagem significativamente menor.

### D2 — Porta do Postgres restrita a 127.0.0.1

A porta do banco é publicada apenas na interface local (`127.0.0.1:5432`), de modo que somente processos da própria máquina conseguem se conectar. Com o padrão `0.0.0.0`, o banco ficaria acessível a qualquer dispositivo da rede, um risco desnecessário para um ambiente de desenvolvimento.

### D3 — Liveness sem dependências externas

O endpoint `/health/live` verifica apenas se o processo está respondendo. Se ele dependesse do banco, uma indisponibilidade do PostgreSQL faria o orquestrador considerar todas as instâncias mortas e reiniciá-las em loop, sem resolver o problema, já que a falha está no banco, e não na aplicação. A verificação das dependências externas (PostgreSQL e SQS) fica a cargo do `/health/ready`: quando ele falha, a instância deixa de receber tráfego, mas continua em execução até que as dependências se recuperem.

### D4 — Dinheiro com decimal.js, nunca `number`

O tipo `number` do JavaScript é um ponto flutuante binário e não representa com exatidão valores decimais como `0.1`. Cada operação carrega um pequeno erro de representação, que se acumula e torna comparações e arredondamentos não confiáveis. Por isso, valores monetários nascem como string (`"25.00"`) e são convertidos diretamente para `Decimal`, sem passar por `number` em nenhum momento.

Exemplo obtido em teste: `1.005 * 100` resulta em `100.49999999999999`. Ao converter R$ 1,005 para centavos com arredondamento, o resultado seria 100, e não 101: um centavo perdido silenciosamente. Em um sistema que processa milhões de transações, erros desse tipo geram divergências entre o saldo e o ledger que não têm explicação contábil.

A principal alternativa seria armazenar valores em centavos inteiros (`2500` em vez de `"25.00"`). Optou-se pela biblioteca decimal por três motivos: o contrato da API já trafega strings decimais, o que evita conversões em toda entrada e saída; a representação é legível; e o próprio modelo de referência do desafio adota `Decimal`.

### D5 — Formato e limites do `Money`

O `Money` aceita apenas o formato rígido do contrato: parte inteira, ponto e exatamente duas casas decimais (`"25.00"`). Entradas como `"25"` ou `"25.5"` são rejeitadas. O README define escala fixa de 2 casas, e o formato único torna o contrato inequívoco — o provedor sabe exatamente o que enviar — e simplifica a validação. A validação é feita por expressão regular, como allowlist: só o que segue o padrão é aceito. Delegar a validação à decimal.js não bastaria, pois ela aceita entradas como `"Infinity"` e `"1e3"`.

O valor máximo é de 17 dígitos inteiros (`99999999999999999.99`), alinhado com a coluna `NUMERIC(19, 2)` do banco: domínio e persistência aceitam exatamente o mesmo intervalo. Além disso, a decimal.js trabalha por padrão com 20 dígitos significativos e arredonda silenciosamente resultados maiores, o que causaria perda de valores. Por isso, o `Money` usa uma instância própria da biblioteca (`Decimal.clone`) com precisão de 34 dígitos, sem alterar a configuração global.

A moeda é validada apenas pelo formato: três letras maiúsculas, no padrão ISO-4217. Códigos inexistentes, como `"XYZ"`, passariam pela validação. Isso é suficiente neste desafio, que opera apenas em BRL, e o modelo permanece multi-moeda.

O `Money` verifica o tipo dos valores em tempo de execução (`typeof`), mesmo com o TypeScript declarando `amount` como string. Os tipos do TypeScript são removidos na execução, e um provedor pode enviar o valor como número no JSON (`"amount": 25.55`). Sem a verificação, a expressão regular converteria esse número em texto e o aceitaria. A camada HTTP também valida a entrada, mas o domínio se protege por conta própria, como defesa em profundidade.

Nas comparações, `equals` entre moedas diferentes retorna `false`, pois a pergunta "25 BRL é igual a 25 USD?" tem resposta: não. Já `isLessThan` lança `CurrencyMismatchError`, pois "10 BRL é menor que 25 USD?" não tem resposta sem uma taxa de câmbio, e retornar `true` ou `false` seria inventar um resultado. O zero negativo (`-0`), que a decimal.js representa, é sempre exibido como `"0.00"` e nunca é considerado negativo: um `"-0.00"` em um extrato não tem significado financeiro. Por isso, as consultas usam `greaterThan(0)` e `lessThan(0)`, em vez dos métodos `isPositive` e `isNegative` da biblioteca, que tratam o zero de forma diferente.

### D6 — Desenho da `Wallet`

A `Wallet` recebe os IDs e a data como parâmetros, em vez de gerá-los internamente. Assim, o domínio não depende de gerador de UUID nem do relógio, e pode ser testado com valores fixos. O lançamento é criado antes de alterar o saldo: se a validação falhar, a carteira continua como estava. A verificação de saldo do `debit` não protege contra duas instâncias debitando ao mesmo tempo, pois cada uma tem sua cópia em memória; essa proteção fica a cargo do banco, por meio do controle de versão da carteira e da constraint de saldo não negativo.

### D7 — Códigos de falha

Todo erro de domínio tem um `code` estável, como `INSUFFICIENT_FUNDS` ou `CURRENCY_MISMATCH`. A mensagem pode mudar, mas o código faz parte do contrato, e com ele o provedor decide se corrige o payload, desiste da operação ou reenvia mais tarde.

As reversões (`REFUND` e `ROLLBACK`) têm códigos próprios (D16), como `REFERENCE_ALREADY_REVERSED` e `AMOUNT_MISMATCH`, para que a operação saiba *por que* uma reversão foi recusada: uma duplicata e um valor divergente pedem ações diferentes.

### D8 — Schema e constraints no banco

As migrations são escritas à mão porque o gerador do MikroORM não cria várias das proteções necessárias, e assim cada regra fica visível no código. O banco garante saldo não negativo, uma carteira por jogador e moeda, a conta do extrato, a moeda do lançamento igual à da carteira e aritmética exata com `numeric`. O extrato é imutável: um trigger cancela qualquer `UPDATE` ou `DELETE`, e outro bloqueia o `TRUNCATE`, que apaga a tabela inteira sem passar linha por linha.

O pacote oficial MikroORM + NestJS não foi usado porque declara dependência do NestJS 11, e o projeto usa o 12. Em vez de arriscar uma incompatibilidade, a integração foi feita manualmente, com pouco código.

### D9 — Lock pessimista por carteira

A escolha do lock pessimista foi motivada pela natureza das operações financeiras do sistema. Uma mesma carteira pode receber múltiplas apostas em sequência (hot wallet), tornando importante serializar suas operações e evitar que diferentes transações utilizem simultaneamente o mesmo saldo disponível. Na prática, a carteira é lida com `SELECT ... FOR UPDATE` dentro da transação: as operações concorrentes esperam a vez e, ao prosseguir, já leem o saldo atualizado. Com lock otimista, as operações concorrentes falhariam ao salvar e precisariam de um laço de retry, o que seria frequente justamente nas carteiras mais disputadas.

O bloqueio é realizado em nível de linha, evitando um lock global e permitindo que carteiras distintas sejam processadas concorrentemente.

O controle de versão (`UPDATE ... WHERE version = ?`) funciona como uma camada adicional de detecção de conflitos, enquanto a constraint `balance >= 0` no banco representa a última barreira de integridade dos dados.

A estratégia foi validada experimentalmente: com o `FOR UPDATE` removido, o controle de versão impediu o débito duplicado e o saldo negativo, mas recusas limpas (`422 INSUFFICIENT_FUNDS`) passaram a virar erros de concorrência (`503`). No mesmo experimento, as 50 cópias da mesma aposta continuaram gerando um único débito, mostrando que duplicação e concorrência são protegidas por mecanismos independentes: a idempotência pela unicidade no banco, e a concorrência pelo lock. 

### D10 — SQL explícito em vez de entidades do ORM

Foi utilizado SQL explícito (`em.execute`) tendo em vista o lock e o controle de versão, que são o centro da correção, para que fiquem visíveis e sob controle, e para controlar a conversão do dinheiro sem nunca passar por `number`: o banco devolve os valores como texto (`balance::text`), que entram direto no `Money.from`. Todos os valores são enviados como parâmetros, nunca concatenados ao SQL, o que protege contra SQL injection. O MikroORM continua cuidando do pool de conexões com o banco, das transações e das migrations. O custo é escrever à mão o mapeamento entre as linhas do banco e o domínio, com a vantagem de explicitar toda a operação, facilitando a revisão e a auditoria.


### D11 — Idempotência persistente

A idempotência evita que uma mesma operação, reenviada pelo provedor ou entregue mais de uma vez, seja processada duas vezes. A fonte da verdade é o header `Idempotency-Key`, gravado com constraint `UNIQUE` no banco (a combinação `provider_id` + `external_transaction_id` também é única). Em vez de conferir se a chave existe e depois inserir, o que deixa uma brecha entre os dois passos em que duas requisições simultâneas passariam pela verificação, a transação é inserida diretamente e o próprio banco recusa a segunda. A recusa vira um replay. Como a garantia está no banco, ela vale para qualquer número de instâncias.

Para distinguir uma repetição de um uso indevido da mesma chave, cada transação guarda um `payloadHash`: o SHA-256 de um JSON canônico, com as chaves ordenadas recursivamente e os campos ausentes omitidos, calculado apenas sobre os campos de negócio. O header e o `correlationId` ficam de fora, pois são metadados de transporte e mudam a cada reenvio.

Se o hash for igual, a requisição recebe o resultado original — o mesmo `transactionId`, status, `failureCode` e o saldo observado no momento do processamento, guardado em `observed_balance` —, com `idempotentReplay: true` e status `200`. Se o hash for diferente, é um conflito: a resposta é `409 IDEMPOTENCY_CONFLICT` e nada é processado.

Transações recusadas por regra de negócio, como `INSUFFICIENT_FUNDS`, também são gravadas. Assim, o reenvio de uma operação recusada devolve a recusa original, mesmo que o saldo tenha mudado depois. O teste com 50 requisições idênticas em paralelo comprova o comportamento: um único processamento, 49 replays e um único débito.

### D12 — Operações de rodada: BET, WIN e LOSS

Estas são as operações básicas de uma rodada. A `BET` debita da carteira do jogador e, caso falte saldo, é recusada com `INSUFFICIENT_FUNDS`, mas a transação é gravada como `REJECTED` para posterior auditoria. A `WIN` credita. A `LOSS` é `PROCESSED` sem alterar saldo, versão ou extrato, pois o valor apostado já foi debitado pela `BET`.

Todas reutilizam o mesmo fluxo, com lock, idempotência, outbox e uma única transação SQL. A diferença fica apenas na função `resolveAgainstWallet`, que decide o efeito de cada tipo na carteira (e, nas reversões, valida a transação referenciada).

Toda transação processada gera o evento `WagerTransactionProcessed`. O `WalletBalanceChanged` é gerado somente quando o saldo de fato muda, por isso a `LOSS` não o gera. Uma transação recusada gera o `WagerTransactionRejected`.

O status `PENDING` só existe em memória: a transação é gravada já com o seu resultado, então ninguém de fora vê uma transação pela metade. A única exceção é `PENDING_REFERENCE` (D16), um estado persistido e visível de propósito, que só pode avançar para `PROCESSED` ou `REJECTED`.

`REFUND` e `ROLLBACK` estão descritos na D16. A `WIN` aceita a referência opcional à aposta, mas ainda não a valida (ver seção 4).

### D13 — Observabilidade

Os logs em JSON aproveitam o `ConsoleLogger` do próprio Nest, que já oferece essa saída como opção. Cada registro traz `correlationId`, `transactionId`, `walletId`, `providerId` e o resultado da operação, o suficiente para rastrear qualquer transação. Valores em dinheiro e o saldo do jogador não são registrados, por exigência de privacidade e segurança: os logs costumam circular por mais sistemas e pessoas do que o banco.

As métricas são expostas em `GET /metrics`, no formato do Prometheus, que coleta os valores periodicamente e permite criar gráficos e alertas. Elas cobrem transações por tipo e status, replays, conflitos de idempotência, conflitos de concorrência, divergências de reconciliação, latência de processamento o outbox lag (quantidade de eventos pendentes e idade do mais antigo, calculados no momento da coleta), eventos publicados e retries de publicação, além de mensagens consumidas, retries e envios para a DLQ no consumidor SQS. Se o publicador parar, o outbox lag cresce continuamente, que é exatamente o sinal que essa métrica deve dar para disparar um alerta.

Quando ocorre um erro inesperado, o cliente recebe apenas `INTERNAL_ERROR`, e os detalhes vão para o log. Assim, nenhuma informação interna, como stack traces ou a estrutura do banco, é exposta a quem chama a API.

### D14 — Autenticação não implementada

A autenticação não foi implementada: o README indica que ela não vale pontos e não deve competir com o núcleo financeiro. Como ponto de extensão explícito, o `ProviderAuthGuard`, que hoje permite todas as requisições, já está aplicado aos controllers usados pelos provedores. Os endpoints de health e o `/metrics` ficam de fora de propósito, pois são acessados pelo orquestrador e pela ferramenta de monitoramento, sem credenciais.

O desenho previsto é validar um token OIDC emitido por um Identity Provider externo, como o Keycloak: a aplicação verificaria a assinatura do token com as chaves públicas do IdP (JWKS) e passaria a exigir que o `providerId` do token seja igual ao do payload. Sem essa última verificação, um provedor autenticado poderia enviar transações em nome de outro.

A escolha de um guard, e não de um middleware, se deve ao momento em que cada um atua: o guard roda depois da escolha da rota e sabe qual endpoint será executado, enquanto o middleware age antes, sem saber qual rota vai atender a requisição.

### D15 — Mensageria: outbox, consumidor e inbox

Foi escolhido o MiniStack como emulador do SQS em vez do LocalStack, pois o LocalStack passou a exigir conta e token em 2026. O README do desafio aceita ambos.

O sistema usa duas filas FIFO com papéis distintos: `wager-transactions.fifo`, por onde **entram** transações enviadas pelos provedores, e `wagering-events.fifo`, por onde **saem** os eventos de integração gerados pelo processamento.

**Saída: Transactional Outbox.** A operação financeira e a intenção de publicar o evento são gravadas na mesma transação PostgreSQL. Um worker em segundo plano consulta os eventos pendentes e utiliza `SELECT ... FOR UPDATE SKIP LOCKED` para reivindicá-los, permitindo que várias instâncias dividam o trabalho sem aguardar pelas linhas já bloqueadas por outra. Após publicar no SQS, o evento é marcado como publicado. Se o processo cair antes de confirmar essa marcação, a transação é desfeita, o lock é liberado e outra instância poderá reivindicar o evento. Falhas do broker reagendam a tentativa com backoff exponencial, sem descartar o evento.

A publicação trabalha com garantia `at-least-once`: se o evento chegar ao SQS, mas o publicador cair antes de marcá-lo como publicado, ele será publicado novamente. O `eventId` é utilizado como `MessageDeduplicationId`, e o SQS FIFO descarta duplicatas dentro da sua janela de deduplicação. Como essa janela é limitada, os consumidores desses eventos (sistemas externos a este serviço) devem tratar o `eventId` como chave de idempotência, sem depender exclusivamente do broker.

**Entrada: consumidor com inbox.** O consumidor da fila de transações reutiliza o mesmo caso de uso do HTTP, evitando duplicar as regras financeiras. A inbox registra a combinação `consumer_name` + `message_id`, em que o `message_id` vem do corpo da mensagem, e não do `MessageId` gerado pelo SQS, que muda a cada reenvio. O registro na inbox e o efeito financeiro acontecem na mesma transação SQL, garantindo que ambos sejam confirmados ou revertidos juntos. O `DeleteMessage` (ACK) só é executado depois do commit no PostgreSQL, evitando confirmar uma mensagem antes de garantir a persistência do processamento.

As falhas são classificadas conforme sua natureza: sucessos e recusas de negócio são confirmados com ACK; mensagens já processadas são confirmadas sem repetir o efeito financeiro; erros transitórios não recebem ACK e voltam para a fila após o Visibility Timeout, ajustado com backoff; após atingir o `maxReceiveCount`, o SQS encaminha a mensagem para a DLQ pela redrive policy. Mensagens malformadas são encaminhadas diretamente para a DLQ. O erro `CONCURRENT_WALLET_UPDATE`, embora seja um `DomainError`, é tratado como transitório, pois representa um conflito de concorrência que pode ser resolvido em uma nova tentativa.

O encerramento do consumidor também considera o recebimento de `SIGTERM`: o worker para de buscar novas mensagens, permite que a mensagem em andamento termine e devolve imediatamente a visibilidade das mensagens restantes do lote, para que outra instância as processe sem esperar o timeout.

Essa abordagem evita a perda de eventos entre a confirmação da operação financeira e sua publicação, além de permitir recuperação diante de falhas no processamento. O custo é aceitar possíveis entregas duplicadas, exigindo idempotência dos consumidores, além da complexidade adicional de manter workers, retries, inbox e DLQ. A escolha prioriza a consistência financeira e a capacidade de recuperação em vez de tentar garantir entrega única em todas as etapas.

### D16 — Reversões: REFUND, ROLLBACK e PENDING_REFERENCE

O provedor pode precisar desfazer uma operação: o `REFUND` devolve uma aposta cancelada (só pode referenciar uma `BET`, e credita o valor), e o `ROLLBACK` desfaz uma operação que não deveria ter existido (pode referenciar `BET`, `WIN` ou `REFUND`, e faz o movimento inverso da original). As reversões nunca apagam nada: são transações novas que apontam para a original (`reference_transaction_id`) e corrigem o saldo com um novo lançamento no extrato, que continua imutável.

Cada transação pode ser revertida no máximo uma vez, qualquer que seja o tipo da reversão. Isso impede, por exemplo, que um `REFUND` e um `ROLLBACK` da mesma `BET` creditem o valor da aposta duas vezes. A regra é verificada dentro do lock da carteira e garantida também por um índice único parcial no banco, como última defesa. Uma primeira versão aplicava a regra por tipo e permitia exatamente esse crédito em dobro; um teste de `REFUND` seguido de `ROLLBACK` expôs o problema, e a correção foi feita no código e no índice, por meio de uma nova migration.

Toda reversão é validada contra a original: valor, tipo, carteira, jogador, rodada e status. Cada problema tem um código próprio (`AMOUNT_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`), porque cada um pede uma ação diferente de quem opera: uma duplicata pode ser ignorada, enquanto um valor divergente indica erro no provedor.

Em um sistema distribuído, a reversão pode chegar antes da original. Aplicá-la às cegas seria imprudente, e recusá-la na hora perderia uma devolução legítima que ainda está a caminho. Por isso, ela é gravada como `PENDING_REFERENCE`, sem alterar o saldo, e a API responde `202`. Um worker em segundo plano, que usa `FOR UPDATE SKIP LOCKED` como o publicador da outbox, tenta novamente com backoff exponencial (de 2 segundos até 5 minutos). Se a original chegar, a reversão é validada e aplicada normalmente; após 10 tentativas sem ela, é recusada com `REFERENCE_NOT_FOUND`, para que nenhuma pendência fique esperando para sempre.

O trade-off mais delicado é o `ROLLBACK` de uma `WIN` cujo valor o jogador já apostou: desfazê-la deixaria o saldo negativo. O sistema recusa com `REVERSAL_INSUFFICIENT_FUNDS` e preserva a regra de saldo não negativo, deixando a cobrança para a operação, em vez de criar uma dívida automática na carteira.

## 3. O que não foi implementado (e como seria feito)

### Réplicas da aplicação no Docker Compose

Hoje o Compose sobe apenas o PostgreSQL e o SQS (MiniStack), e a aplicação roda com `bun run dev`. A correção com várias instâncias não depende disso: toda a coordenação acontece no PostgreSQL (lock por carteira, unicidade da idempotência, `FOR UPDATE SKIP LOCKED` na outbox e nas pendências), e o teste com 3 processos separados disputando a mesma carteira comprova o comportamento.

Para subir réplicas reais, o caminho seria:

- um `Dockerfile` baseado na imagem oficial do Bun, executando `bun src/main.ts`;
- um serviço `migrate`, de execução única, que aplica as migrations antes de qualquer réplica subir, para que várias instâncias não tentem migrar o banco ao mesmo tempo;
- um serviço `app` com `deploy.replicas: 3`, apontando para `postgres` e `sqs` pelos nomes da rede interna do Compose, com `depends_on` condicionado ao healthcheck do banco, do SQS e ao término do `migrate`;
- um balanceador (nginx ou Traefik) como única porta exposta, distribuindo as requisições entre as réplicas e usando o `/health/ready` para tirar do ar uma instância sem dependências.

### Autenticação dos provedores

Descrita na D14: o `ProviderAuthGuard` já está aplicado aos controllers como ponto de extensão. A implementação validaria um token OIDC emitido por um Identity Provider (por exemplo, Keycloak), verificando a assinatura pelas chaves públicas (JWKS), e exigiria que o `providerId` do token fosse igual ao do payload, para que um provedor autenticado não possa enviar transações em nome de outro. No consumidor SQS, a mesma garantia viria do controle de acesso à fila (IAM), e não de um token por mensagem.

### Teste de carga

A concorrência foi validada por testes de integração, mas não sob carga sustentada. Um cenário com k6 cobriria três situações: muitas carteiras em paralelo (vazão), uma carteira muito disputada (o pior caso do lock pessimista) e reenvios em massa da mesma transação (idempotência). As métricas observadas seriam a latência p95/p99 em `wagering_processing_duration_seconds`, a taxa de respostas `503`, os conflitos de concorrência e o outbox lag, para identificar o limite de vazão por carteira e por instância.

### Reprocessamento da DLQ

Mensagens que esgotam as tentativas ou chegam malformadas vão para a DLQ e ficam lá. Não há uma ferramenta para inspecioná-las e devolvê-las à fila principal. A implementação seria um comando operacional que lista as mensagens da DLQ com o motivo registrado e as reenvia sob demanda (ou usa o redrive nativo da AWS). O reenvio é seguro, porque a inbox e a idempotência impedem que uma mensagem já processada gere um segundo efeito financeiro.

### Reconciliação agendada

A reconciliação existe (`POST /wallets/:walletId/reconciliation`), mas só roda quando é chamada. Em produção, um job periódico percorreria as carteiras movimentadas desde a última execução, comparando o saldo com o extrato, e emitiria a métrica de divergência para disparar um alerta. Assim como hoje, o job apenas sinalizaria: uma divergência em um sistema financeiro deve ser investigada por uma pessoa, e não corrigida automaticamente.

## 4. Limitações conhecidas

- **Chave de idempotência global.** A chave é única no sistema inteiro, e não por provedor: dois provedores que usem a mesma chave colidem, e o segundo recebe `409`. Não há vazamento de dados entre eles, porque o hash do payload inclui o `providerId`. Correção: unicidade por `(provider_id, idempotency_key)`.

- **Erros transitórios embrulhados pelo ORM.** O filtro HTTP reconhece falhas transitórias pelo `code` do PostgreSQL; um deadlock que chegue embrulhado em uma classe de erro do MikroORM pode virar `500` em vez de `503`. Com o lock por carteira, deadlocks são improváveis. Correção: desembrulhar a causa original do erro antes de classificá-lo.

- **Inbox e duplicatas detectadas pela idempotência.** A inbox registra apenas mensagens que chegaram a ser processadas. Uma mensagem com `messageId` diferente, mas com a mesma operação, é detectada pela chave de idempotência e confirmada sem registro na inbox. O efeito financeiro continua único; falta apenas o rastro na inbox.

- **WIN sem validação da BET.** A `WIN` aceita a referência à aposta, mas não verifica se ela existe ou pertence à mesma rodada. Correção: reaproveitar a validação de referência já usada pelas reversões (D16).

- **Prazo de `PENDING_REFERENCE` contado em tentativas.** O limite é de 10 tentativas com backoff (até 5 minutos entre elas), e não um prazo de negócio definido pelo provedor. Se a original chegar depois da última tentativa, a reversão já terá sido recusada com `REFERENCE_NOT_FOUND`, e o provedor precisará reenviá-la.

- **Pendência que falha sempre (poison pill).** Se o reprocessamento de uma pendência lançar um erro inesperado, a transação é desfeita sem registrar a tentativa; por ser a mais antiga, ela é tentada de novo e atrasa as demais. Nenhum caminho conhecido provoca esse erro, porque valores e referências são validados antes. Correção: registrar a tentativa em uma transação separada, antes do processamento.

- **ROLLBACK de uma reversão pendente.** Um `ROLLBACK` que referencia um `REFUND` ainda em `PENDING_REFERENCE` é recusado na hora com `REFERENCE_NOT_PROCESSED`, em vez de também aguardar.

- **ROLLBACK de uma WIN já gasta.** É recusado com `REVERSAL_INSUFFICIENT_FUNDS`, para não quebrar a regra de saldo não negativo; a cobrança do jogador fica para um processo manual da operação (D16).

- **Reversibilidade das migrations.** O `down` e o `up` foram verificados manualmente, e não por teste automatizado: uma migration futura pode ter um `down` quebrado sem que nenhum teste perceba. Correção: um teste que aplique, reverta e reaplique todas as migrations em um banco vazio.

- **Sem teste de carga.** A concorrência foi validada por testes de integração (incluindo 3 processos separados disputando a mesma carteira), mas não sob carga sustentada. Correção: um cenário com k6 medindo latência e taxa de conflitos.

- **SQS validado apenas no MiniStack.** Não havia conta AWS no escopo do desafio. Na AWS real, podem variar limites, latência, janela de deduplicação e permissões (IAM), que o emulador não reproduz por completo.