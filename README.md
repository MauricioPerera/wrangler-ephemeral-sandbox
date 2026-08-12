# 🧪 Ephemeral Sandbox

Un espacio efímero para que un **agente** ejecute JavaScript vía HTTP — sin login, sin Docker, sin instalar nada — y que se **autodestruye solo** en ~1 hora. Pensado para ser llamado por código (un agente de IA como herramienta), no para uso humano por navegador.

Hermano de [wrangler-ephemeral-chat](https://github.com/MauricioPerera/wrangler-ephemeral-chat), [wrangler-ephemeral-whiteboard](https://github.com/MauricioPerera/wrangler-ephemeral-whiteboard) y [wrangler-ephemeral-airdrop](https://github.com/MauricioPerera/wrangler-ephemeral-airdrop) — misma cuenta temporal de Cloudflare, pero para ejecutar código en vez de chatear/dibujar/compartir archivos.

## Por qué no es un `eval()` cualquiera

Se intentaron dos caminos antes de llegar a este, y ambos **fallan en cuentas `--temporary`** — vale la pena documentarlo porque no es obvio:

1. **`eval()` / `new Function()` directo en el Worker**: Cloudflare lo bloquea en runtime con `Code generation from strings disallowed for this context`. Solo se permite generación de código dinámico durante el *arranque* del script, nunca mientras se procesa un request.
2. **Dynamic Workers (`worker_loaders`)**: es la solución oficial de Cloudflare para ejecutar código de terceros de forma aislada — pero requiere **plan pago**: *"In order to use Dynamic Workers, you must switch to a paid plan"*. No hay forma de usarlo en una cuenta temporal/gratuita.

**La solución que sí funciona**: empaquetar un intérprete de JavaScript compilado a WebAssembly ([QuickJS](https://github.com/justjake/quickjs-emscripten)) dentro del propio Worker. El código del agente corre *dentro* del WASM, no vía `eval` del Worker — así que la restricción de Cloudflare ni se activa, y de paso conseguís aislamiento real: el código ejecutado no tiene `fetch`, no tiene acceso a los bindings del Worker, no tiene nada salvo lo que le inyectamos explícitamente (`console`).

## Cómo funciona

- `wrangler deploy --temporary` crea una cuenta de Cloudflare temporal (sin login) y despliega el Worker (~600KB, la mayoría es el binario WASM de QuickJS).
- `POST /new` crea una sesión (token random → un Durable Object propio).
- `POST /s/<token>/exec` con `{"code": "..."}` corre ese código dentro de una instancia QuickJS fresca, captura `console.log` y el valor de `return`, y guarda el resultado en el historial SQLite de esa sesión.
- El código corre sin red, sin filesystem, sin acceso a bindings — un sandbox de verdad, no una lista negra de nombres.

## Requisitos

- Node.js
- Wrangler **4.102.0 o superior**
- **No estar logueado** en Wrangler (`wrangler logout` si ya tenés sesión)

## Deploy

```bash
git clone https://github.com/MauricioPerera/wrangler-ephemeral-sandbox.git
cd wrangler-ephemeral-sandbox
npm install
npx wrangler deploy --temporary
```

## Uso (API para agentes)

```bash
# Crear una sesión
curl -X POST https://<worker>.<slug>.workers.dev/new
# → {"token":"...", "url":"https://.../s/<token>", "execUrl":"https://.../s/<token>/exec"}

# Ejecutar código
curl -X POST https://<worker>.<slug>.workers.dev/s/<token>/exec \
  -H "content-type: application/json" \
  -d '{"code": "console.log(\"hola\"); return 21 * 2;"}'
# → {"ok":true,"result":"42","logs":["\"hola\""],"error":null,...}

# Ver el historial de la sesión
curl https://<worker>.<slug>.workers.dev/s/<token>/history
```

El código se ejecuta como cuerpo de una función — usá `return` para devolver un valor. También hay una página HTML en `/s/<token>` para probar manualmente desde el navegador.

## Límites (probados, no solo teóricos)

- **Sin red real**: `typeof fetch` adentro del sandbox devuelve `"undefined"` — no es una lista de nombres bloqueados, el entorno QuickJS no tiene esas APIs para empezar.
- **Protección contra loops infinitos por pasos de intérprete, no por tiempo**: `Date.now()` no avanza durante un loop síncrono apretado dentro de un isolate de Workers, así que un límite basado en deadline (`shouldInterruptAfterDeadline`) nunca dispara contra un `while(true){}` real — lo confirmamos empíricamente (tardó 43s en cortar, vía el límite de CPU de Cloudflare, no el nuestro). La solución es contar invocaciones del interrupt handler del intérprete (`MAX_INTERRUPT_CHECKS` en `src/index.js`, actualmente 5000) — un loop infinito corta en ~1-2 segundos, sin afectar cómputo legítimo (un `for` de 100,000 iteraciones corre entero sin problema).
- **16MB de memoria y 320KB de stack** por ejecución (configurable en `src/index.js`).
- **20,000 caracteres máximo** de código por ejecución.
- **Sin persistencia de variables entre ejecuciones**: cada llamada a `/exec` es un contexto QuickJS nuevo. Si el agente necesita estado entre pasos, tiene que reenviar el código acumulado.

## Estructura

```
src/index.js       — Worker + Durable Object (Sandbox) + páginas HTML + runtime QuickJS
src/quickjs.wasm   — intérprete QuickJS (variante release-sync) compilado a WASM
wrangler.jsonc      — config del Worker y binding del Durable Object
```

## ¿Sos un agente de IA?

Ver [AGENTS.md](./AGENTS.md) para instrucciones de despliegue autónomo con `wrangler --temporary`, y para entender cómo usar este sandbox como herramienta de ejecución de código.
