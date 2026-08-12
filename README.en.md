# 🧪 Ephemeral Sandbox

🌐 [Español](./README.md) · **English** · [Português](./README.pt.md)

An ephemeral space for an **agent** to execute JavaScript over HTTP — no login, no Docker, nothing to install — that **self-destructs** in ~1 hour. Meant to be called by code (an AI agent using it as a tool), not for human browser use.

Sibling of [wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat), [wrangler-ephemeral-whiteboard](https://github.com/MauricioPerera/wrangler-ephemeral-whiteboard), and [wrangler-ephemeral-airdrop](https://github.com/MauricioPerera/wrangler-ephemeral-airdrop) — same Cloudflare temporary account, but for executing code instead of chatting/drawing/sharing files.

## Why this isn't just an `eval()`

Two approaches were tried before landing on this one, and both **fail on `--temporary` accounts** — worth documenting since it's not obvious:

1. **Direct `eval()` / `new Function()` in the Worker**: Cloudflare blocks this at runtime with `Code generation from strings disallowed for this context`. Dynamic code generation is only allowed during script *startup*, never while handling a request.
2. **Dynamic Workers (`worker_loaders`)**: Cloudflare's official solution for running third-party code in isolation — but it requires a **paid plan**: *"In order to use Dynamic Workers, you must switch to a paid plan"*. There's no way to use it on a temporary/free account.

**What actually works**: bundling a JavaScript interpreter compiled to WebAssembly ([QuickJS](https://github.com/justjake/quickjs-emscripten)) inside the Worker itself. The agent's code runs *inside* the WASM, not via the Worker's own `eval` — so Cloudflare's restriction never triggers, and as a bonus you get real isolation: the executed code has no `fetch`, no access to the Worker's bindings, nothing except what we explicitly inject (`console`).

## How it works

- `wrangler deploy --temporary` creates a temporary Cloudflare account (no login) and deploys the Worker (~600KB, mostly the QuickJS WASM binary).
- `POST /new` creates a session (random token → its own Durable Object).
- `POST /s/<token>/exec` with `{"code": "..."}` runs that code inside a fresh QuickJS instance, captures `console.log` and the `return` value, and stores the result in that session's SQLite history.
- The code runs with no network, no filesystem, no access to bindings — a real sandbox, not a blocklist of names.

## Requirements

- Node.js
- Wrangler **4.102.0 or later**
- **Not logged in** to Wrangler (`wrangler logout` if you already have a session)

## Deploy

```bash
git clone https://github.com/MauricioPerera/wrangler-ephemeral-sandbox.git
cd wrangler-ephemeral-sandbox
npm install
npx wrangler deploy --temporary
```

## Usage (API for agents)

```bash
# Create a session
curl -X POST https://<worker>.<slug>.workers.dev/new
# → {"token":"...", "url":"https://.../s/<token>", "execUrl":"https://.../s/<token>/exec"}

# Execute code
curl -X POST https://<worker>.<slug>.workers.dev/s/<token>/exec \
  -H "content-type: application/json" \
  -d '{"code": "console.log(\"hello\"); return 21 * 2;"}'
# → {"ok":true,"result":"42","logs":["\"hello\""],"error":null,...}

# View the session's history
curl https://<worker>.<slug>.workers.dev/s/<token>/history
```

The code executes as a function body — use `return` to produce a value. There's also an HTML page at `/s/<token>` for manual testing from the browser.

## Limits (tested, not just theoretical)

- **No real network access**: `typeof fetch` inside the sandbox returns `"undefined"` — this isn't a blocklist of names, the QuickJS environment simply doesn't have those APIs to begin with.
- **Infinite-loop protection is step-based, not time-based**: `Date.now()` does not advance during a tight synchronous loop inside a Workers isolate, so a deadline-based limit (`shouldInterruptAfterDeadline`) never fires against a real `while(true){}` — confirmed empirically (it took 43s to stop, via Cloudflare's own CPU limit, not ours). The fix is counting interpreter interrupt-handler invocations instead (`MAX_INTERRUPT_CHECKS` in `src/index.js`, currently 5000) — an infinite loop cuts off in ~1-2 seconds, without affecting legitimate work (a 100,000-iteration `for` loop runs to completion fine).
- **16MB of memory and 320KB of stack** per execution (configurable in `src/index.js`).
- **20,000 character maximum** of code per execution.
- **No variable persistence between executions**: each call to `/exec` is a fresh QuickJS context. If the agent needs state across steps, it has to resend the accumulated code.

## Structure

```
src/index.js       — Worker + Durable Object (Sandbox) + HTML pages + QuickJS runtime
src/quickjs.wasm   — QuickJS interpreter (release-sync variant) compiled to WASM
wrangler.jsonc      — Worker config and Durable Object binding
```

## Are you an AI agent?

See [AGENTS.md](./AGENTS.md) for autonomous deployment instructions with `wrangler --temporary`, and for how to use this sandbox as a code-execution tool.
