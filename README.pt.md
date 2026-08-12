# 🧪 Ephemeral Sandbox

🌐 [Español](./README.md) · [English](./README.en.md) · **Português**

Um espaço efêmero para que um **agente** execute JavaScript via HTTP — sem login, sem Docker, sem instalar nada — e que **se autodestrói sozinho** em ~1 hora. Pensado para ser chamado por código (um agente de IA usando como ferramenta), não para uso humano pelo navegador.

Irmão de [wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat), [wrangler-ephemeral-whiteboard](https://github.com/MauricioPerera/wrangler-ephemeral-whiteboard) e [wrangler-ephemeral-airdrop](https://github.com/MauricioPerera/wrangler-ephemeral-airdrop) — mesma conta temporária da Cloudflare, mas para executar código em vez de conversar/desenhar/compartilhar arquivos.

## Por que isso não é um `eval()` qualquer

Duas abordagens foram tentadas antes de chegar nesta, e ambas **falham em contas `--temporary`** — vale a pena documentar porque não é óbvio:

1. **`eval()` / `new Function()` direto no Worker**: a Cloudflare bloqueia isso em runtime com `Code generation from strings disallowed for this context`. Geração dinâmica de código só é permitida durante a *inicialização* do script, nunca enquanto processa um request.
2. **Dynamic Workers (`worker_loaders`)**: é a solução oficial da Cloudflare para executar código de terceiros de forma isolada — mas exige **plano pago**: *"In order to use Dynamic Workers, you must switch to a paid plan"*. Não há como usar numa conta temporária/gratuita.

**A solução que funciona de verdade**: empacotar um interpretador de JavaScript compilado para WebAssembly ([QuickJS](https://github.com/justjake/quickjs-emscripten)) dentro do próprio Worker. O código do agente roda *dentro* do WASM, não via `eval` do Worker — então a restrição da Cloudflare nem é ativada, e de brinde você ganha isolamento real: o código executado não tem `fetch`, não tem acesso aos bindings do Worker, não tem nada além do que injetamos explicitamente (`console`).

## Como funciona

- `wrangler deploy --temporary` cria uma conta temporária da Cloudflare (sem login) e implanta o Worker (~600KB, a maior parte é o binário WASM do QuickJS).
- `POST /new` cria uma sessão (token aleatório → seu próprio Durable Object).
- `POST /s/<token>/exec` com `{"code": "..."}` roda esse código dentro de uma instância QuickJS nova, captura `console.log` e o valor de `return`, e salva o resultado no histórico SQLite dessa sessão.
- O código roda sem rede, sem sistema de arquivos, sem acesso a bindings — um sandbox de verdade, não uma lista negra de nomes.

## Requisitos

- Node.js
- Wrangler **4.102.0 ou superior**
- **Não estar logado** no Wrangler (`wrangler logout` se já tiver sessão)

## Deploy

```bash
git clone https://github.com/MauricioPerera/wrangler-ephemeral-sandbox.git
cd wrangler-ephemeral-sandbox
npm install
npx wrangler deploy --temporary
```

## Uso (API para agentes)

```bash
# Criar uma sessão
curl -X POST https://<worker>.<slug>.workers.dev/new
# → {"token":"...", "url":"https://.../s/<token>", "execUrl":"https://.../s/<token>/exec"}

# Executar código
curl -X POST https://<worker>.<slug>.workers.dev/s/<token>/exec \
  -H "content-type: application/json" \
  -d '{"code": "console.log(\"oi\"); return 21 * 2;"}'
# → {"ok":true,"result":"42","logs":["\"oi\""],"error":null,...}

# Ver o histórico da sessão
curl https://<worker>.<slug>.workers.dev/s/<token>/history
```

O código é executado como corpo de uma função — use `return` para retornar um valor. Também tem uma página HTML em `/s/<token>` para testar manualmente pelo navegador.

## Limites (testados, não só teóricos)

- **Sem rede de verdade**: `typeof fetch` dentro do sandbox retorna `"undefined"` — não é uma lista de nomes bloqueados, o ambiente QuickJS simplesmente não tem essas APIs para começar.
- **Proteção contra loops infinitos por passos do interpretador, não por tempo**: `Date.now()` não avança durante um loop síncrono apertado dentro de um isolate de Workers, então um limite baseado em prazo (`shouldInterruptAfterDeadline`) nunca dispara contra um `while(true){}` de verdade — confirmado empiricamente (demorou 43s para cortar, via o limite de CPU da própria Cloudflare, não o nosso). A solução é contar invocações do interrupt handler do interpretador (`MAX_INTERRUPT_CHECKS` em `src/index.js`, atualmente 5000) — um loop infinito corta em ~1-2 segundos, sem afetar trabalho legítimo (um `for` de 100.000 iterações roda inteiro sem problema).
- **16MB de memória e 320KB de stack** por execução (configurável em `src/index.js`).
- **20.000 caracteres no máximo** de código por execução.
- **Sem persistência de variáveis entre execuções**: cada chamada a `/exec` é um contexto QuickJS novo. Se o agente precisar de estado entre passos, tem que reenviar o código acumulado.

## Estrutura

```
src/index.js       — Worker + Durable Object (Sandbox) + páginas HTML + runtime QuickJS
src/quickjs.wasm   — interpretador QuickJS (variante release-sync) compilado para WASM
wrangler.jsonc      — config do Worker e binding do Durable Object
```

## Você é um agente de IA?

Veja [AGENTS.md](./AGENTS.md) para instruções de deploy autônomo com `wrangler --temporary`, e para entender como usar este sandbox como ferramenta de execução de código.
