# Arquitetura — Distributed Wagering Processor

## 1. Visão geral

<!-- Escrever no final: o que o sistema faz, em um parágrafo, e o que foi entregue. -->

## 2. Diário de decisões

<!-- Cada decisão: o que foi decidido, por quê, qual alternativa existia e qual o custo da escolha. -->

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

### D12 — Operações implementadas: BET, WIN e LOSS

Estas são as operações que movem o sistema. A `BET` debita da carteira do jogador e, caso falte saldo, é recusada com `INSUFFICIENT_FUNDS`, mas a transação é gravada como `REJECTED` para posterior auditoria. A `WIN` credita. A `LOSS` é `PROCESSED` sem alterar saldo, versão ou extrato, pois o valor apostado já foi debitado pela `BET`.

Todas reutilizam o mesmo fluxo, com lock, idempotência, outbox e uma única transação SQL. A diferença fica apenas na função `applyToWallet`, que decide o efeito de cada tipo na carteira.

Toda transação processada gera o evento `WagerTransactionProcessed`. O `WalletBalanceChanged` é gerado somente quando o saldo de fato muda, por isso a `LOSS` não o gera. Uma transação recusada gera o `WagerTransactionRejected`.

O status `PENDING` só existe em memória: a transação é gravada uma única vez, já no estado final, então ninguém de fora vê uma transação pela metade.

`REFUND` e `ROLLBACK` são recusados com `501` (ver seção 3). A `WIN` aceita a referência opcional à aposta, mas ainda não a valida.

### D13 — Observabilidade

Os logs em JSON aproveitam o `ConsoleLogger` do próprio Nest, que já oferece essa saída como opção. Cada registro traz `correlationId`, `transactionId`, `walletId`, `providerId` e o resultado da operação, o suficiente para rastrear qualquer transação. Valores em dinheiro e o saldo do jogador não são registrados, por exigência de privacidade e segurança: os logs costumam circular por mais sistemas e pessoas do que o banco.

As métricas são expostas em `GET /metrics`, no formato do Prometheus, que coleta os valores periodicamente e permite criar gráficos e alertas. Elas cobrem transações por tipo e status, replays, conflitos de idempotência, conflitos de concorrência, divergências de reconciliação, latência de processamento e o outbox lag (quantidade de eventos pendentes e idade do mais antigo, calculados no momento da coleta). Como o publicador da outbox ainda não existe, o lag cresce continuamente, que é exatamente o sinal que essa métrica deve dar quando o publicador para. Métricas de retries e de DLQ dependem do consumidor SQS e não foram implementadas.

Quando ocorre um erro inesperado, o cliente recebe apenas `INTERNAL_ERROR`, e os detalhes vão para o log. Assim, nenhuma informação interna, como stack traces ou a estrutura do banco, é exposta a quem chama a API.

### D14 — Autenticação não implementada

A autenticação não foi implementada: o README indica que ela não vale pontos e não deve competir com o núcleo financeiro. Como ponto de extensão explícito, o `ProviderAuthGuard`, que hoje permite todas as requisições, já está aplicado aos controllers usados pelos provedores. Os endpoints de health e o `/metrics` ficam de fora de propósito, pois são acessados pelo orquestrador e pela ferramenta de monitoramento, sem credenciais.

O desenho previsto é validar um token OIDC emitido por um Identity Provider externo, como o Keycloak: a aplicação verificaria a assinatura do token com as chaves públicas do IdP (JWKS) e passaria a exigir que o `providerId` do token seja igual ao do payload. Sem essa última verificação, um provedor autenticado poderia enviar transações em nome de outro.

A escolha de um guard, e não de um middleware, se deve ao momento em que cada um atua: o guard roda depois da escolha da rota e sabe qual endpoint será executado, enquanto o middleware age antes, sem saber qual rota vai atender a requisição.

## 3. O que não foi implementado (e como seria feito)

<!-- Preencher no final. -->

## 4. Limitações conhecidas

<!-- Preencher no final. -->