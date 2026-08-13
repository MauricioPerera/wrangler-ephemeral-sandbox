# Guía para agentes: desplegar y usar este sandbox

Este proyecto es, en sí mismo, una herramienta para que un agente ejecute código. Esta guía cubre dos cosas: cómo desplegarlo con `wrangler --temporary`, y cómo usarlo una vez desplegado.

Si lo que el usuario necesita no es ejecutar código sino inspeccionar webhooks entrantes, usá el repo hermano [wrangler-ephemeral-webhook](https://github.com/MauricioPerera/wrangler-ephemeral-webhook/blob/master/AGENTS.md).

## Paso 1 — Confirmar que NO hay sesión activa

```bash
npx wrangler whoami
```

Si hay sesión logueada, `--temporary` no crea cuenta temporal — corre igual pero contra la cuenta real del usuario, sin error. Revisar siempre antes.

## Paso 2 — Instalar y desplegar

```bash
npm install
npx wrangler deploy --temporary
```

El binario `src/quickjs.wasm` ya está commiteado en el repo (no depende de `npm install` para existir), así que el deploy funciona en un clone limpio sin pasos extra.

## Paso 3 — Verificar que funciona de verdad

```bash
BASE="https://<worker>.<slug>.workers.dev"
TOKEN=$(curl -sS -X POST "$BASE/new" | python -c "import json,sys; print(json.load(sys.stdin)['token'])")

curl -sS -X POST "$BASE/s/$TOKEN/exec" -H "content-type: application/json" \
  -d '{"code":"console.log(\"probe\"); return 1+1;"}'
# esperar: {"ok":true,"result":"2","logs":["\"probe\""],"error":null,...}
```

Si `ok` no es `true` con ese código trivial, no reportar el deploy como exitoso.

## Cómo usarlo como herramienta de un agente

1. `POST /new` una vez al empezar una tarea → guardar el `token`/`execUrl`.
2. Por cada snippet a correr: `POST /s/<token>/exec` con `{"code": "..."}`. El código es el cuerpo de una función — usar `return` para el valor de salida.
3. Leer `result` (string, JSON-stringified) y `logs` (array de strings de `console.log`). Si `error` no es `null`, el código falló (excepción o interrupción por loop).
4. No hay estado JS entre llamadas — para persistir datos entre pasos o entre sesiones, usar `POST /s/<token>/db/exec` y `POST /s/<token>/db/query` (D1 real, compartida por toda la cuenta), no reenviar código acumulado.

## Gotchas específicos de este proyecto (encontrados construyéndolo, no en la doc oficial)

- **`eval`/`new Function` están bloqueados en Workers en producción.** Solo funcionan durante el arranque del script (`allow_eval_during_startup`), nunca procesando un request. Cualquier intento de sandbox vía eval directo falla con `Code generation from strings disallowed for this context`.
- **Dynamic Workers (`worker_loaders`) requiere plan pago.** Es la alternativa "oficial" de Cloudflare para este caso de uso, pero no sirve para `--temporary` — falla con `In order to use Dynamic Workers, you must switch to a paid plan [code: 10195]`.
- **`shouldInterruptAfterDeadline` (basado en `Date.now()`) NO corta un `while(true){}` dentro de un Worker.** `Date.now()` no avanza durante un loop síncrono apretado en un isolate de Workers — confirmado empíricamente (tardó 43s en cortar, vía el límite de CPU de la plataforma, no el nuestro). Usar en cambio un interrupt handler que cuenta invocaciones (`MAX_INTERRUPT_CHECKS`), no tiempo.
- Si se toca `src/index.js`, recompilar/copiar de nuevo el wasm solo hace falta si se cambia de variante de QuickJS — el archivo actual (`@jitl/quickjs-wasmfile-release-sync`) ya está commiteado.
- **D1 se auto-provisiona en `wrangler deploy --temporary`** con solo declarar `d1_databases` en `wrangler.jsonc` sin `database_id` — no hace falta correr `wrangler d1 create` a mano primero. Confirmado empíricamente.
- **D1 es async, QuickJS `RELEASE_SYNC` no soporta funciones nativas async.** Por eso el acceso a D1 NO está inyectado dentro del sandbox de JS (`db.query(...)` dentro de un `/exec` no existe) — son dos endpoints HTTP aparte (`/db/exec`, `/db/query`) que el agente llama por fuera del sandbox. La alternativa (variante `RELEASE_ASYNC` de QuickJS con host functions async) no se probó — es un riesgo de compatibilidad no verificado, se descartó a propósito por simplicidad y certeza.

## Gotchas heredados (compartidos con los proyectos hermanos)

- Wrangler cachea la cuenta temporal en `wrangler-temporary-account.toml`. Si expiró y falla con `Authentication error [code: 10000]`, borrar ese archivo antes de reintentar.
- El timer de 60 minutos es fijo desde la creación, no se extiende con actividad.

## Paso 4 — Comunicar el resultado

Entregar la URL raíz del deploy y la claim URL (aclarando la ventana de ~1 hora). Si el usuario quiere usar el sandbox como herramienta persistente para un agente, aclarar que expira en 1 hora salvo que reclame la cuenta — no es apto para producción de largo plazo, solo para sesiones de trabajo puntuales.
