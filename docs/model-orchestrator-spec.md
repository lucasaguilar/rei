# Spec: Model Orchestrator — "one model mode" (memory-aware model hot-swap)

> Estado: **análisis / propuesta** (no implementado). Documento de trabajo.
> Fecha: 2026-08-18.

## 1. Idea / objetivo

Correr **multi-modelo + multi-provider** en una Mac con memoria limitada (ej. 48 GB
unified) **sin preocuparse por la RAM**: que solo haya **UN modelo grande cargado a la
vez**, y que rei haga el **unload/load automático** al cambiar de modo cuando el modo
nuevo usa otro modelo en otro backend.

### Caso de uso real del usuario
- **ask / planning** → modelo **MoE rápido** (ej. `ornith 35b-a3b` o `qwen3.6 35b-a3b`)
  — "vuelan" en velocidad (3B activos), ideales para respuestas/planificación ágiles.
- **agent** → **qwen3.8-27b DENSE** — más inteligente para ejecutar/editar, y en **MTPLX
  corre mucho más rápido que en LM Studio** (~24-26 tok/s decode).
- Problema: **ambos son grandes** (35B MoE + 27B dense) → **no coexisten cómodos** en 48 GB
  con KV cache → hoy hay que elegir uno y cargar/descargar a mano.

Flujo deseado:
```
estoy en agent  → MTPLX con qwen3.8-27b cargado
cambio a ask    → rei detecta que ask usa ornith@lmstudio y que NO entran los dos
                → unload de MTPLX (qwen3.8) + load de LM Studio (ornith)
vuelvo a agent  → unload de LM Studio (ornith) + load de MTPLX (qwen3.8) again
```

## 2. Lo que rei YA tiene (medio camino hecho)

La resolución **"qué modelo para qué modo"** ya existe:
- `resolveModelForMode(mode)` (provider-factory.ts) → `<PROVIDER>_MODEL_AGENT` para agent,
  `<PROVIDER>_MODEL` para ask/planning.
- `MODEL_PROVIDER` (ask/planning) vs `AGENT_MODEL_PROVIDER` (agent) → permite provider
  distinto por modo.
- `rei.config.json` per-model tuning por provider (`providers.<name>.models[]`).

→ Config-side: ya se puede declarar *ask=lmstudio/ornith, agent=mtplx/qwen3.8*. **Lo que
falta es la ORQUESTACIÓN** (unload/load físico).

## 3. Lo que falta: `ModelOrchestrator`

Componente nuevo, hookeado al **cambio de modo** (y al arranque). Responsabilidad:

1. Resolver el **target** (provider + model) del modo entrante.
2. Comparar con el/los modelo(s) **cargado(s)**.
3. Si difiere **y** no coexisten según el **presupuesto de memoria** → `unloadModel(actual)`
   + `loadModel(target)`. Si coexisten → no tocar nada (dejar ambos cargados).

Necesita una **abstracción por backend**:
```ts
interface ModelBackend {
  load(model: string): Promise<void>;
  unload(model: string): Promise<void>;
  loaded(): Promise<string[]>;      // qué está cargado ahora
  estimatedFootprintGB(model: string): number; // pesos + KV aprox
}
```

## 4. Factibilidad por backend

| Backend    | ¿Load/unload programático? | Cómo |
|------------|----------------------------|------|
| **LM Studio** | ✅ Sí | CLI `lms load <m>` / `lms unload <m>`; o JIT-load on request + TTL auto-unload |
| **Ollama**    | ✅ Sí | `keep_alive: 0` en el request descarga; load = un request cualquiera |
| **MTPLX**     | ✅ **Sí, vía CLI** (verificado 2026-08-18) | El *server* no tiene hot-swap, pero el **CLI `mtplx`** sí: `mtplx stop --port <p> --json` (unload) + `mtplx quickstart --model <ref> --model-id <served> --port <p> <flags> --yes --json` (load headless). Scripteable como `lms`. Sigue siendo un stop+start (reload de disco), pero **limpio**, no matar procesos a mano. |

### OPEN QUESTION #1 — Control API de MTPLX → **RESUELTO (2026-08-18)**
Enumerado el server `mtplx.server.openai` (:8003) vía `/openapi.json`. **NO existe endpoint
de load/unload/switch de modelo.** Rutas relevantes:
- Inferencia: `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/messages`,
  `/v1/rerank`.
- `/v1/models` → sirve **exactamente UN modelo** (`mtplx-qwen38-27b-optimized-speed`).
- `/admin/cache/clear`, `/admin/sessions/...` → limpian CACHE/sesiones, **no** descargan pesos.
- `POST /v1/mtplx/settings` → cambia settings **en runtime SIN restart**:
  `mutable_settings = [reasoning, generation_mode, depth, temperature, top_p, top_k,
  presence_penalty, frequency_penalty, max_response_tokens, enable_thinking,
  reasoning_parser, reasoning_effort, prefill_chunk_tokens, draft_temperature/top_p/top_k]`.
  → el **modelo** cae en `restart_required_settings` (no se puede hot-swap).
- No hay endpoint para **liberar los pesos** manteniendo el proceso vivo → mientras `mtplx
  serve` corra, el modelo ocupa memoria. Para liberarlo hay que **matar el proceso**.

**Conclusión (actualizada tras revisar el CLI):** el *server* no tiene hot-swap, PERO el
**CLI `mtplx` es limpio y scripteable** (v2.8.3) — no hay que matar procesos a mano:
- **UNLOAD:** `mtplx stop --port 8003 --json` (`--grace-seconds` antes de SIGKILL; sin
  `--port` auto-encuentra el server).
- **LOAD (headless, no-interactivo):** `mtplx quickstart --model <ref> --model-id <served>
  --port 8003 --profile turbo --depth 3 [--paged-kv-quantization q8] [--ssd-session-cache on]
  --yes --json` (`--dry-run` para previsualizar).
- **Listar cache / estado:** `mtplx models`, `mtplx status --json`.
- **`--json` en todos** → salida machine-readable → ideal para orquestar desde rei.

→ El backend MTPLX del orquestador = **CLI-driven start/stop** (como `lms` de LM Studio), no
proceso crudo. Sigue costando el **reload de disco** en cada swap, pero es prolijo y robusto.

**Mitigación del cache perdido:** `--ssd-session-cache on` **persiste el prompt-cache en SSD**
→ tras el reload, MTPLX puede **restaurar el prefijo** desde disco y ahorrar re-prefill (suaviza
el mayor costo del swap). Vale activarlo si se va a swapear seguido.

**Tie-back KV quant:** `--paged-kv-quantization {off,q8,q4}` es **flag de lanzamiento**
(restart-required) → la elección Q8/Q4 del KV cache se fija al hacer el `quickstart`/`serve`,
no en vivo.

**Coordinación con MTPLX.app:** si la app está corriendo y maneja su propio daemon, hay que
evitar que rei y la app se pisen (dos daemons en el mismo puerto). Definir "dueño" del proceso
(o que rei solo orqueste cuando la app no esté al mando).

**Settings mutables útiles (bonus):** `kv_quant_policy` / `paged_kv_quantization`,
`context_window_policy`, `sampling_defaults`, `metal_memory_caps` aparecen en `/v1/mtplx/settings`
→ la **cuantización del KV cache** (Q8/Q4 que consultaste) es configurable por acá / la app,
sin tocar el modelo.

### OPEN QUESTION #2 — `lms` CLI disponible
Confirmar que `lms load/unload` está instalado y responde (o usar la REST API de LM Studio).

## 5. Estrategia de activación — **parámetro vs auto por memoria**

Análisis de la pregunta del usuario ("¿siempre por parámetro, o cuando los dos no entren
en memoria según el presupuesto actual?"). **Respuesta: las DOS cosas, en capas.**

1. **Master switch (opt-in, por parámetro).** El feature NO debe estar prendido por
   default — un unload/reload sorpresa de 10-60s en cada cambio de modo sería un shock.
   Flag: `REI_MODEL_ORCHESTRATION=1` (o setting en `rei.config.json`).

2. **Dentro de "enabled" → decisión por PRESUPUESTO DE MEMORIA (auto).** El swap solo se
   dispara cuando los modelos **NO entran juntos**:
   - Si `footprint(actual) + footprint(target) + reserva_KV <= presupuesto` → **coexisten →
     NO swap** (los deja cargados, cero latencia). Ej: ask=4B chico + agent=27B → entran →
     no swapea nunca.
   - Si **no entran** → unload + load. Ej (caso del usuario): ornith-35B + qwen3.8-27B → no
     entran en 48 GB → swap.

→ Así el mismo mecanismo sirve para el que quiere modelos chicos coexistiendo (nunca
swapea) y para el que quiere dos grandes (swapea solo cuando hace falta). **No es
"siempre por parámetro" ni "siempre auto": es opt-in + auto-gated-by-budget.**

### Presupuesto de memoria — cómo estimarlo
- **Total:** RAM/unified disponible (configurable `REI_MEMORY_BUDGET_GB`, o auto-detect).
- **Footprint por modelo:** aprox = `params × bytes/param` (Q8≈1B/param → 27B≈27 GB;
  Q4≈0.5 → ~13.5 GB; MoE cuenta params TOTALES para pesos) **+ KV cache** (∝ contexto).
  Mejor: declarar `sizeGB` por modelo en `rei.config.json` (el usuario sabe su realidad),
  con el cálculo como fallback.

## 6. El costo real: LATENCIA + pérdida de cache

- **Cargar un modelo grande de disco = 10-60s** por cada transición que requiera swap.
- **Se pierde el prompt-cache / estado de sesión** del backend descargado (justo lo que
  ahorraba prefill en MTPLX).
- Mitigaciones:
  - Solo swapea cuando NO coexisten (ver §5) → si podés meter un ask chico, nunca pagás.
  - Avisar en la UI ("♻️ swapping qwen3.8 → ornith, ~20s…") para que la espera no sorprenda.
  - No swapear en cambios de modo efímeros (debounce): si el usuario vuelve a agent en <N s,
    no vale la pena haber descargado.

## 7. Diseño / sketch de implementación

```
mode-switch (CLI / intent-router)
   └─ ModelOrchestrator.onModeChange(newMode):
        target   = resolveModelForMode(newMode) + provider del modo
        loaded   = orchestrator.currentlyLoaded()
        if target ya cargado: return (no-op)
        if fits(loaded + target, budget): loadModel(target); return  // coexisten
        else:
          for m in loaded que compiten por memoria: unloadModel(m)
          loadModel(target)
```
- **Idempotente**: si el target ya está cargado, no hace nada.
- **Manejo de errores**: si `loadModel(target)` falla → recargar el anterior / avisar y
  no cambiar de modo (no dejar al usuario sin modelo).
- **Gate**: todo esto solo corre si `REI_MODEL_ORCHESTRATION` está on.

## 8. Alternativa más simple (evaluar PRIMERO)

Si **ask/planning puede ser un modelo CHICO** (ej. 4B) que **coexista** con el 27B del
agente → **cero swap, cero latencia**, y rei ya lo soporta hoy (per-mode provider+model).
**Pero** el usuario quiere específicamente sus **MoE grandes** (ornith/qwen3.6-35b-a3b) en
ask/planning por velocidad+calidad → esos NO coexisten con el 27B dense → **para su caso el
orquestador con swap es la opción correcta.** (Un 4B no le da la calidad/velocidad que ya
tiene con los MoE.)

## 9. Encaja con features existentes de rei
- [[rei-model-selection-per-mode]] — la base per-mode ya está.
- [[rei-intent-router]] — el auto mode-switch dispararía el orquestador.
- [[rei-per-model-config]] — donde declarar `sizeGB` por modelo.
- [[rei-config-doctor-proposal]] — el doctor podría avisar "estos 2 no entran juntos →
  necesitás orchestration".

## 10. TODO / próximos pasos
1. **Verificar control API de MTPLX** (OPEN QUESTION #1) — decide si el swap es limpio o
   requiere manejar el proceso.
2. Confirmar `lms` CLI / REST de LM Studio (OPEN QUESTION #2).
3. Definir el modelo de `footprint` + `budget` (config vs auto-detect).
4. Prototipo: `ModelBackend` para LM Studio (el más fácil) + el gate por memoria.
5. Recién después, MTPLX (según #1).
