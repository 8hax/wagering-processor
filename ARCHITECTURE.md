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

## 3. O que não foi implementado (e como seria feito)

<!-- Preencher no final. -->

## 4. Limitações conhecidas

<!-- Preencher no final. -->