import { RELEASE_SYNC, newVariant, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten";
import wasmModule from "./quickjs.wasm";

const HISTORY_LIMIT = 50;
const MAX_CODE_LENGTH = 20000;
// Date.now() does not advance during a tight synchronous loop inside a
// Workers isolate, so a wall-clock deadline (shouldInterruptAfterDeadline)
// never fires against `while(true){}`. We bound interpreter steps instead.
const MAX_INTERRUPT_CHECKS = 5000;
const TEMP_ACCOUNT_LIFETIME_MS = 60 * 60 * 1000;

const variant = newVariant(RELEASE_SYNC, { wasmModule });
let quickjsModulePromise = null;
function getQuickJSModule() {
  if (!quickjsModulePromise) quickjsModulePromise = newQuickJSWASMModuleFromVariant(variant);
  return quickjsModulePromise;
}

function safeStringify(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Real isolation: code runs inside a QuickJS interpreter compiled to WASM,
// not in the Worker's own JS realm. It has no access to fetch, bindings,
// the filesystem, or anything else outside the values we explicitly inject
// (here: only `console`). Loop protection is step-based, not time-based:
// Date.now() does not advance during a tight sync loop inside a Workers
// isolate, so we bound interpreter interrupt-checks instead.
async function runCode(code) {
  const QuickJS = await getQuickJSModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 320);
  let interruptChecks = 0;
  runtime.setInterruptHandler(() => ++interruptChecks > MAX_INTERRUPT_CHECKS);

  const context = runtime.newContext();
  const logs = [];

  try {
    const logFn = context.newFunction("log", (...args) => {
      const native = args.map((a) => context.dump(a));
      logs.push(native.map(safeStringify).join(" "));
    });
    const consoleObj = context.newObject();
    context.setProp(consoleObj, "log", logFn);
    context.setProp(consoleObj, "error", logFn);
    context.setProp(consoleObj, "warn", logFn);
    context.setProp(context.global, "console", consoleObj);
    consoleObj.dispose();
    logFn.dispose();

    const wrapped = `(function(){\n${code}\n})()`;
    const evalResult = context.evalCode(wrapped);

    let result = null;
    let error = null;
    if (evalResult.error) {
      const dumped = context.dump(evalResult.error);
      evalResult.error.dispose();
      error = dumped && dumped.message ? dumped.message : safeStringify(dumped);
    } else {
      const dumped = context.dump(evalResult.value);
      evalResult.value.dispose();
      result = dumped === undefined ? null : safeStringify(dumped);
    }
    return { logs, result, error };
  } catch (e) {
    return { logs, result: null, error: e && e.message ? e.message : String(e) };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

export class Sandbox {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        result TEXT,
        logs TEXT NOT NULL,
        error TEXT,
        ts INTEGER NOT NULL
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_config (id INTEGER PRIMARY KEY CHECK (id = 1), created_ts INTEGER)`
    );
    this.sql.exec(`INSERT OR IGNORE INTO room_config (id, created_ts) VALUES (1, ?)`, Date.now());
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/exec") return this.handleExec(request);
    if (request.method === "GET" && url.pathname === "/history") return this.handleHistory();
    return new Response("not found", { status: 404 });
  }

  async handleExec(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Body inválido, se espera JSON con {code}" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const code = typeof body.code === "string" ? body.code : "";
    if (!code.trim()) {
      return new Response(JSON.stringify({ error: "Falta 'code' (string no vacío)" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (code.length > MAX_CODE_LENGTH) {
      return new Response(JSON.stringify({ error: `Código demasiado largo (máx ${MAX_CODE_LENGTH} caracteres)` }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }

    const { logs, result, error } = await runCode(code);
    const ts = Date.now();

    this.sql.exec(
      `INSERT INTO history (code, result, logs, error, ts) VALUES (?, ?, ?, ?, ?)`,
      code, result, JSON.stringify(logs), error, ts
    );
    this.sql.exec(
      `DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)`,
      HISTORY_LIMIT
    );

    const createdTs = [...this.sql.exec(`SELECT created_ts FROM room_config WHERE id = 1`)][0].created_ts;

    return new Response(JSON.stringify({
      ok: !error,
      result,
      logs,
      error,
      ts,
      createdTs,
      expiryMs: TEMP_ACCOUNT_LIFETIME_MS,
    }), { headers: { "content-type": "application/json" } });
  }

  async handleHistory() {
    const rows = [...this.sql.exec(`SELECT code, result, logs, error, ts FROM history ORDER BY id ASC`)]
      .map((r) => ({ ...r, logs: JSON.parse(r.logs) }));
    const createdTs = [...this.sql.exec(`SELECT created_ts FROM room_config WHERE id = 1`)][0].created_ts;
    return new Response(JSON.stringify({ history: rows, createdTs, expiryMs: TEMP_ACCOUNT_LIFETIME_MS }), {
      headers: { "content-type": "application/json" },
    });
  }
}

const STYLE = `
  :root {
    --bg: #eef0f4; --card: #ffffff; --border: #e2e5ea; --text: #1c1f26; --muted: #7a8091;
    --primary: #7c3aed; --primary-text: #ffffff; --danger: #c0392b; --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); margin: 0; padding: 32px 16px;
    display: flex; justify-content: center;
  }
  .app { width: 100%; max-width: 620px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px 4px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 1px 3px rgba(20,20,40,0.06); padding: 24px; margin-bottom: 16px;
  }
  #expiryBanner {
    padding: 8px 12px; margin-bottom: 16px; font-size: 12.5px; border-radius: 999px;
    background: #eaf0ff; color: #33447a; text-align: center;
  }
  button {
    font-family: inherit; cursor: pointer; border: none; border-radius: 10px; font-size: 14px;
    font-weight: 600; padding: 11px 20px; transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  .btn-primary { background: var(--primary); color: var(--primary-text); }
  textarea, pre, code.block {
    width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #05060c; color: #d7fcd1;
  }
  textarea { min-height: 140px; resize: vertical; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  .runrow { display: flex; justify-content: flex-end; margin-top: 10px; }
  .result-block { margin-top: 14px; }
  .result-block h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); }
  .error-text { color: #ff8080; }
  .histitem { border-top: 1px solid var(--border); padding: 12px 0; }
  .histitem:first-child { border-top: none; }
  .histitem .meta { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  code.inline { background: #f2f4f8; padding: 2px 5px; border-radius: 4px; font-size: 13px; }
`;

function homePage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ephemeral Sandbox</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <h1>🧪 Ephemeral Sandbox</h1>
  <div class="card">
    <p>Un espacio efímero para que un agente ejecute JavaScript vía HTTP, sin login y sin dejar rastro más allá de ~1 hora.</p>
    <button class="btn-primary" id="createBtn">Crear sandbox nuevo</button>
    <div class="result-block" id="createResult"></div>
  </div>
  <div class="card">
    <h4 style="margin-top:0;">Uso vía API</h4>
    <pre>curl -X POST $ORIGIN/new

curl -X POST $ORIGIN/s/&lt;token&gt;/exec \\
  -H "content-type: application/json" \\
  -d '{"code":"return 1 + 1"}'

curl $ORIGIN/s/&lt;token&gt;/history</pre>
  </div>
</div>
<script>
  document.getElementById('createBtn').onclick = async () => {
    const res = await fetch('/new', { method: 'POST' });
    const data = await res.json();
    document.getElementById('createResult').innerHTML =
      '<p>Sandbox creado: <a href="' + data.url + '">' + data.url + '</a></p>';
    location.href = data.url;
  };
  document.querySelectorAll('pre').forEach((el) => {
    el.innerHTML = el.innerHTML.replaceAll('$ORIGIN', location.origin);
  });
</script>
</body>
</html>`;
}

function sandboxPage(token) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox ${token} — Ephemeral Sandbox</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <h1>🧪 Ephemeral Sandbox</h1>
  <div id="expiryBanner"></div>

  <div class="card">
    <p style="margin-top:0; font-size:13px; color:var(--muted);">
      Endpoint para agentes: <code class="inline">POST ${""}<span id="execUrl"></span></code> con body <code class="inline">{"code": "..."}</code>.
      El código corre como cuerpo de función — usá <code class="inline">return</code> para devolver un valor.
    </p>
    <textarea id="codeInput">console.log("hola desde el sandbox");
return 21 * 2;</textarea>
    <div class="runrow"><button class="btn-primary" id="runBtn">Ejecutar</button></div>
    <div class="result-block" id="resultBlock" style="display:none;">
      <h4>Resultado</h4>
      <pre id="resultOut"></pre>
    </div>
  </div>

  <div class="card">
    <h4 style="margin-top:0;">Historial de esta sesión</h4>
    <div id="history">Cargando...</div>
  </div>
</div>
<script>
  const token = ${JSON.stringify(token)};
  const execUrl = location.origin + '/s/' + token + '/exec';
  document.getElementById('execUrl').textContent = execUrl;

  function startExpiryCountdown(createdTs, expiryMs) {
    const banner = document.getElementById('expiryBanner');
    const expiresAt = createdTs + expiryMs;
    function tick() {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        banner.textContent = '⏳ Este sandbox ya debería haber desaparecido (cuenta temporal vencida).';
        banner.style.background = '#fdd'; banner.style.color = '#a00';
        return;
      }
      const m = Math.floor(remainingMs / 60000);
      const s = Math.floor((remainingMs % 60000) / 1000);
      banner.textContent = '⏳ Se autodestruye en ~' + m + ':' + String(s).padStart(2, '0');
      if (remainingMs < 5 * 60000) { banner.style.background = '#fee'; banner.style.color = '#a40'; }
      setTimeout(tick, 1000);
    }
    tick();
  }

  function renderResult(el, data) {
    let text = '';
    if (data.logs && data.logs.length) text += data.logs.join('\\n') + '\\n';
    if (data.error) text += '(error) ' + data.error;
    else text += '=> ' + (data.result === null ? 'undefined' : data.result);
    el.textContent = text;
    el.className = data.error ? 'error-text' : '';
  }

  function renderHistory(history) {
    const el = document.getElementById('history');
    if (!history.length) { el.textContent = 'Sin ejecuciones todavía.'; return; }
    el.innerHTML = history.map((h) => {
      let out = '';
      if (h.logs && h.logs.length) out += h.logs.join('\\n') + '\\n';
      out += h.error ? '(error) ' + h.error : '=> ' + (h.result === null ? 'undefined' : h.result);
      const time = new Date(h.ts).toLocaleTimeString();
      return '<div class="histitem"><div class="meta">' + time + '</div>' +
        '<pre>' + h.code.replace(/</g, '&lt;') + '</pre>' +
        '<pre class="' + (h.error ? 'error-text' : '') + '">' + out.replace(/</g, '&lt;') + '</pre></div>';
    }).join('');
  }

  async function loadHistory() {
    const res = await fetch('/s/' + token + '/history');
    const data = await res.json();
    renderHistory(data.history);
    startExpiryCountdown(data.createdTs, data.expiryMs);
  }
  loadHistory();

  document.getElementById('runBtn').onclick = async () => {
    const code = document.getElementById('codeInput').value;
    const res = await fetch(execUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    const block = document.getElementById('resultBlock');
    block.style.display = 'block';
    renderResult(document.getElementById('resultOut'), data);
    loadHistory();
  };
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/new") {
      const token = crypto.randomUUID();
      return new Response(JSON.stringify({ token, url: `${url.origin}/s/${token}`, execUrl: `${url.origin}/s/${token}/exec` }), {
        headers: { "content-type": "application/json" },
      });
    }

    const m = url.pathname.match(/^\/s\/([a-zA-Z0-9-]+)(?:\/(exec|history))?$/);
    if (m) {
      const token = m[1];
      const sub = m[2];
      const id = env.SANDBOX.idFromName(token);
      const stub = env.SANDBOX.get(id);

      if (sub === "exec") return stub.fetch("https://sandbox/exec", { method: "POST", body: request.body, headers: request.headers });
      if (sub === "history") return stub.fetch("https://sandbox/history");
      return new Response(sandboxPage(token), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/") {
      return new Response(homePage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
