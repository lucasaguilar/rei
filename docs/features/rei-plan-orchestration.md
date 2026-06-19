# Plan — Orquestación Agéntica Consciente del Hardware (REI)

> Documento vivo. v0.2 — alineado con el plan A2A vía el kernel de ejecución compartido (ver §9 Historial).
> Estado: EN DISEÑO (no implementado). Hardware objetivo: Mac Mini M5, 48 GB unified memory.
>
> **Contrato de integración con el [plan A2A + OTel](<Multi-Agent A2A + OTel.md>):** este plan es DUEÑO de
> las implementaciones de `RunTask` (Orchestrator Engine), `ExecutionLock` (el Model/Execution Lock
> node-wide de ADR 0002 — **no** el mutex interno de load/unload) y `TaskQueue` (cola persistente del
> daemon) definidas en [`src/contracts/execution-contract.ts`](../../src/contracts/execution-contract.ts).
> Ver [plan-integration-contract.md](plan-integration-contract.md) y
> [ADR 0002](../adr/0002-single-model-execution-lock.md) / [ADR 0003](../adr/0003-plan-integration-contract.md).
> El "Orchestrator" de este documento = **Orchestrator Engine** (componente de un solo Nodo); el rol A2A
> que delega se llama **Director** (ver [CONTEXT.md](../../CONTEXT.md)).

---

## 0. Principio rector (no negociable)

El orquestador es una **CAPA DE COMPOSICIÓN OPT-IN**, no una reescritura del loop actual.
Compone las piezas estables existentes y las invoca; no las modifica.

```
Orchestrator (NUEVO, modo /auto opt-in)
  ├── HardwareController        (NUEVO)
  ├── ModelLifecycleManager     (NUEVO, sobre la abstracción de providers)
  ├── Watchdog                  (NUEVO)
  └── usa SIN MODIFICAR:
      · Agent.streamTurn / executeAgentTurn   → ejecución por micro-tarea
      · Sandbox + ts-morph/tree-sitter        → validación AST
      · session-store + plan-tracker          → persistencia/progreso
      · command-executor                      → comandos (pmset, git, etc.)
```

**Retrocompat absoluta:** si el orquestador se apaga o falla, REI funciona exactamente como hoy.

---

## 1. Flujo de orquestación (CORREGIDO)

1. **PLANIFICACIÓN MACRO** — modelo denso (Qwen 3.6 27B) → plan en etapas macro.
2. **DESCOMPOSICIÓN MICRO** — el denso divide la etapa actual en micro-tareas dinámicas.
3. **EJECUCIÓN + VALIDACIÓN AST** — el denso genera el patch → sandbox valida con ts-morph/tree-sitter.
4. **APLICACIÓN TRANSACCIONAL** — si AST ok: **checkpoint git** → aplicar al código real (rollback si falla a medias).
5. **ENFRIAMIENTO REACTIVO** *(cambiado)* — NO sleep fijo. Leer `pmset -g therm`; pausar con backoff **solo si hay throttling** (`CPU_Speed_Limit < 100`), hasta volver a 100. Abortable.
6. **AUDITORÍA FINAL CON SWAP ÚNICO** *(cambiado)* — el denso queda cargado durante TODA la ejecución; **un solo swap al MoE 30B al final** (no por etapa) para la auditoría crítica global. Luego se descarga todo.

### Cambios clave vs spec original

| Spec original | Decisión actualizada | Razón |
|---------------|----------------------|-------|
| Sleep fijo 45s por micro-tarea | Pausa **reactiva** (`pmset -g therm` + backoff) | El calor es de la inferencia ya terminada; 45s×N dominan el runtime |
| Swap de modelo por etapa macro | **Swap único al final** (auditoría MoE) | Cold-loads de 27B/30B × N etapas = costo prohibitivo |
| Confiar en el 200 del unload | **Pollear modelos cargados** antes de cargar el siguiente | El unload no libera RAM sincrónicamente → riesgo de swap de OS |
| Watchdog "en paralelo" | **Gate síncrono** (AST-fail) + **AbortController/timeout** (hang) — separados | Son dos modos de falla distintos |
| Reset de `retry_count` en hard-reset | Contador `hardResetCount` **separado con tope** | Evita loop infinito de hard-resets |
| (faltaba) aplicar al real | **Checkpoint git** + rollback | Atomicidad ante crash a mitad de escritura |
| (faltaba) gestión ts-morph | Reuso de `Project` + `tree.delete()` + cleanup en `finally` | Fugas de memoria nativa en proceso largo |

---

## 2. Riesgos identificados (checklist a cubrir)

### Fugas de memoria (Node + AST)
- [ ] ts-morph: reusar un único `Project`; `project.removeSourceFile()` tras cada validación; medir `heapUsed` entre etapas.
- [ ] tree-sitter: `tree.delete()` SIEMPRE (memoria nativa invisible al GC de V8).
- [ ] Contexto del sub-loop micro: comprimir/descartar historial+reasoning de micro-tareas completadas (no acumular KV cache ni tokens).
- [ ] Temp sandbox dirs: limpieza en `finally` en TODOS los caminos (éxito, error, watchdog, SIGINT).
- [ ] Timers/promesas: todo `sleep` y toda llamada al LLM debe ser **abortable** (`AbortController`).

### Race conditions / RAM
- [ ] **ExecutionLock node-wide (ADR 0002):** serializa la tarea COMPLETA — cada trigger (interactivo, A2A-inbound, agendado) lo adquiere antes de ejecutar. Es el lock de concurrencia (N=1 por Nodo).
- [ ] **Invariante interno de `swapTo` (NO es un segundo lock):** CERO inferencia durante load/unload; el loop es lineal → basta confirmar-unload-luego-load (no hay inferencia concurrente que cubrir).
- [ ] Confirmar unload (poll endpoint de cargados) antes de load → evitar doble ocupación → swap de OS.
- [ ] 48GB: 27B (~16-20GB q4) + 30B MoE (~18-20GB) + KV + OS + Node → nunca solapar cargas.

### Crash recovery / estado
- [ ] Crash durante swap: sesión dice "ejecutando" pero no hay modelo → al resumir, detectar y recargar.
- [ ] Crash durante aplicación: checkpoint git da punto de retorno.
- [ ] `SUSPENDED_BY_WATCHDOG`: contrato de `/resume` claro (qué se restaura).

---

## 3. Componentes (interfaces TypeScript)

```typescript
// ── Serialización node-wide a nivel de TAREA (ADR 0002 / contrato) ──
// EL lock que cada trigger (interactivo, A2A-inbound, agendado) adquiere ANTES de ejecutar una tarea.
// Node-wide y a nivel de tarea (un Nodo, una tarea a la vez, N=1). Es el `ExecutionLock` del contrato
// — distinto del invariante de load/unload interno de `swapTo` (§2). NO lo adquiere `run()`: lo adquiere
// el consumidor (el Worker del daemon, o el fast-path síncrono de A2A).
interface ExecutionLock {
  acquire(signal: AbortSignal): Promise<() => void>;   // resuelve con una función de release
}

// ── Providers: extensión OPCIONAL (retrocompat) — = `ModelLifecycle` del contrato ──
interface ModelProvider {
  // ... existente sin cambios ...
  loadModel?(model: string): Promise<void>;
  unloadModel?(model: string): Promise<void>;
  isModelLoaded?(model: string): Promise<boolean>; // contra endpoint real, no el 200 del unload
}

// ── Hardware ──
interface ThermalReading { cpuSpeedLimit: number; throttling: boolean; }
interface HardwareController {
  readThermal(): Promise<ThermalReading>;          // parsea `pmset -g therm` (sin sudo)
  coolDownIfNeeded(signal: AbortSignal): Promise<void>; // pausa adaptativa solo si throttling
}

// ── RAM / swap de modelos ──
interface ModelLifecycleManager {
  swapTo(target: { provider: string; model: string }, signal: AbortSignal): Promise<void>;
  unloadAll(): Promise<void>;
  current(): { provider: string; model: string } | null;
}

// ── Watchdog ──
interface MicroTaskFailureState { retryCount: number; hardResetCount: number; }
type WatchdogAction =
  | { kind: "retry" }
  | { kind: "hard_reset"; freshPrompt: string }
  | { kind: "suspend"; reason: string };
interface Watchdog {
  onAstFailure(taskId: string, state: MicroTaskFailureState): WatchdogAction;
  withHangGuard<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T>;
}
```

---

## 4. Máquina de estados (extiende la sesión actual; campos opcionales = retrocompat)

```typescript
type OrchestrationState =
  | "MACRO_PLANNING" | "MICRO_DECOMPOSING" | "MICRO_EXECUTING"
  | "APPLYING" | "COOLING" | "STAGE_AUDIT" | "DONE" | "SUSPENDED_BY_WATCHDOG";

interface OrchestrationSession {
  state: OrchestrationState;
  macroStages: MacroStage[];
  currentMacroIndex: number;
  microTasks: MicroTask[];
  currentMicroIndex: number;
  failures: Record<string /*taskId*/, MicroTaskFailureState>;
  loadedModel: { provider: string; model: string } | null; // para recovery tras crash
  // A2A C7/C12: las delegaciones salientes viven en la sesión → un crash a mitad de delegación
  // resume, y una auditoría MoE delegada (C12) se registra acá en vez de un swap dense→MoE local.
  // Es la forma concreta del `resumable` del `QueuedTask` del contrato.
  delegations: Array<{
    a2aTaskId: string;
    node: string;                                  // label en a2aNodes
    purpose: "moe-audit" | "subtask";
    state: "pending" | "done" | "failed";
    traceparent?: string;
  }>;
}
```

### Loop (con los gates correctos) — pseudocódigo de referencia

```typescript
// El Orchestrator Engine ES el `RunTask` del contrato. El `ExecutionLock` ya lo tiene el llamador
// (el Worker del daemon, o el fast-path síncrono de A2A) → `run()` NO lo re-adquiere. DEBE honrar el
// `signal` del llamador para que A2A tasks/cancel y el Watchdog aborten la corrida (C10). Los llamados
// de abajo (swapTo / sandbox.validate / git.checkpoint / coolDownIfNeeded) son los puntos de span
// model-swap / ast-validate / git-checkpoint / cooling del plan A2A+OTel (IP-3).
async run(req: RunTaskRequest, signal: AbortSignal): Promise<RunTaskResult> {
  const ctrl = new AbortController();
  const relay = () => ctrl.abort();
  signal.addEventListener("abort", relay, { once: true });   // cancel externo → ctrl interno (C10)
  try {
    await modelMgr.swapTo(DENSE, ctrl.signal);
    const stages = await this.macroPlan(req.prompt);

    for (const stage of stages) {
      const micro = await this.decompose(stage, ctrl.signal);
      for (const task of micro) {
        const fail = this.session.failures[task.id] ??= { retryCount: 0, hardResetCount: 0 };
        while (true) {
          const patch = await watchdog.withHangGuard(
            (sig) => agent.runMicroTask(task, sig), HANG_MS);     // hang = timeout real
          const ast = await sandbox.validate(patch);             // ts-morph EXISTENTE
          if (ast.ok) {
            await git.checkpoint();
            await sandbox.applyToReal(patch);
            break;
          }
          fail.retryCount++;
          const action = watchdog.onAstFailure(task.id, fail);   // gate síncrono
          if (action.kind === "retry") continue;
          if (action.kind === "hard_reset") {
            agent.clearTaskContext(task.id);
            task.injectedPrompt = action.freshPrompt;
            fail.retryCount = 0; fail.hardResetCount++;           // contador separado
            continue;
          }
          if (action.kind === "suspend") {
            this.session.state = "SUSPENDED_BY_WATCHDOG";
            await this.notifyHuman(action.reason);
            return { text: `SUSPENDED_BY_WATCHDOG: ${action.reason}` };                                              // congela seguro
          }
        }
        await hardware.coolDownIfNeeded(ctrl.signal);            // reactiva, no fija
      }
    }
    await modelMgr.swapTo(MOE, ctrl.signal);                     // swap único al final
    // C12: si un Nodo peer ya tiene el MoE cargado, se puede delegar la auditoría (registrando el
    // handle en session.delegations) en vez del swap dense→MoE local (ver §8).
    return { text: await this.globalAudit() };                  // RunTaskResult
  } finally {
    signal.removeEventListener("abort", relay);
    ctrl.abort();
    await sandbox.cleanupTemp();
    await modelMgr.unloadAll();
    this.disposeAstResources();   // removeSourceFile + tree.delete()
  }
}
```

---

## 5. Plan de implementación por fases (propuesto — a refinar)

- **Fase 0 — Abstracción de ciclo de vida de modelo.** `loadModel/unloadModel/isModelLoaded` opcionales en ModelProvider; impl. para Ollama (`keep_alive:0` / `ollama stop`) y LM Studio (`/unload` + poll). Sin orquestador todavía. Testeable en aislamiento.
- **Fase 1 — HardwareController.** Parser de `pmset -g therm` + `coolDownIfNeeded` con backoff. Testeable solo.
- **Fase 2 — Watchdog.** Gate síncrono + `withHangGuard`. Tests unitarios de la lógica de escalado.
- **Fase 3 — Orchestrator (esqueleto).** Máquina de estados + persistencia, usando el Agent/Sandbox existentes. Sin swap ni cooling (mocked).
- **Fase 4 — Integración.** Conectar HardwareController + ModelLifecycleManager + Watchdog al orquestador. Checkpoint git transaccional.
- **Fase 5 — Auditoría MoE + recovery.** Swap final, auditoría global, resume desde SUSPENDED/crash.
- **Fase 6 — Capa de Scheduling/Daemon.** (ver sección 6) Scheduler + cola persistente + worker. Opt-in, por encima del orquestador.

---

## 6. Capa de Scheduling / Daemon (ejecución autónoma agendada)

> Capa NUEVA por encima del orquestador. No toca el pipeline de ejecución de una tarea.
> Permite que REI corra desatendido: agendar tareas, ejecutarlas a su horario, encolarlas y resumirlas tras un crash.

### Idea en un párrafo
REI deja de ser solo un CLI interactivo y corre como un **demonio persistente** que es el **host unificado** del kernel de ejecución (ADR 0002): **scheduler + cola + Worker + ExecutionLock + serving A2A**. La cola persistente (reutiliza la persistencia de sesión existente, sobrevive a reinicios/crashes) tiene **tres productores** —el **trigger interactivo**, el **A2A-inbound** (tareas delegadas largas, C3) y el **scheduler** (estilo cron)— más un **fast-path síncrono** para tareas cortas que adquiere el lock y saltea la cola (C5). Un **único Worker** drena la cola **secuencialmente** —una tarea por vez— adquiriendo el `ExecutionLock` node-wide y pasando cada `RunTask` por el orquestador hardware-aware. La asincronía **no es paralelismo**: desacopla *cuándo se agenda/encola* de *cuándo se ejecuta*, pero la ejecución es **serializada a propósito**, porque el constraint de hardware (un solo modelo pesado ~20GB a la vez en 48GB) hace imposible y peligroso —por las race conditions del swap de modelos— correr dos orquestaciones simultáneas. El Worker toma de la cola, adquiere el lock, ejecuta, libera, y recién ahí toma la siguiente.

### Mapeo de las preguntas del usuario
- **"agendar a tal horario"** → el scheduler dispara por tiempo y encola.
- **"ejecutar automáticamente"** → el worker levanta la tarea cuando le toca.
- **"encolar"** → persistir en la cola con orden/prioridad.
- **"manejar la asincronía"** → un solo consumidor + estado persistido + locks → convierte un problema concurrente en uno secuencial y resumible.

### Componentes (interfaces TypeScript)
```typescript
interface ScheduledTask {
  id: string;
  prompt: string;                 // o referencia a un plan guardado
  workspacePath: string;
  schedule: { kind: "cron"; expr: string } | { kind: "once"; at: string /*ISO*/ };
  priority?: number;
  enabled: boolean;
}

type QueuedTaskState = "queued" | "running" | "done" | "failed" | "suspended";
interface QueuedTask {
  id: string;
  request: RunTaskRequest;        // prompt + workspacePath + meta — CUALQUIER trigger, no solo cron
  origin?:                        // de dónde vino (dedupe/auditoría)
    | { kind: "scheduled"; scheduledId: string }
    | { kind: "a2a"; a2aTaskId: string }
    | { kind: "interactive" };
  enqueuedAt: string;
  state: QueuedTaskState;
  attempts: number;
  resumable?: OrchestrationSession; // forma concreta del `resumable` del contrato (sección 4)
}

interface Scheduler {
  register(task: ScheduledTask): void;
  /** Tick: evalúa horarios y encola los que correspondan. Idempotente. */
  tick(now: Date): void;
}

interface TaskQueue {
  enqueue(item: QueuedTask): void;          // persiste a disco
  claimNext(): QueuedTask | null;            // toma 1, marca "running" (atómico)
  complete(id: string, state: QueuedTaskState): void;
  pending(): QueuedTask[];
}

interface Worker {
  /** Loop: claimNext → executionLock.acquire → orquestador.run(req, signal) → release → repeat.
   *  UN solo Worker por Nodo; el MISMO `ExecutionLock` que usa el fast-path síncrono de A2A. */
  start(signal: AbortSignal): Promise<void>;
}
```

### Reglas de diseño
- **Un único Worker** (sin concurrencia de ejecución) — adquiere el `ExecutionLock` node-wide de la sección 3 (ADR 0002).
- **Tres productores, una sola cola** — el trigger interactivo, el A2A-inbound y el scheduler encolan en la MISMA cola; las tareas A2A largas son **productores**, no una segunda cola (C3). El serving A2A vive en este mismo demonio (IP-6).
- **Fast-path síncrono** — tareas cortas adquieren el lock y saltean la cola (C5); sienten inmediato sin solaparse con una corrida pesada.
- **Cola persistente en disco** (`.rei/queue/*.json` o similar) — al reiniciar el demonio, re-hidrata `running` huérfanas como `queued` (o resume vía `resumable`).
- **Scheduler idempotente** — un `tick` perdido no duplica encolados (dedupe por ventana de tiempo + id).
- **Tareas `once`** se desactivan tras ejecutarse; las `cron` re-encolan en el próximo match.
- **Backpressure** — si el Worker está ocupado, los productores solo encolan; nunca ejecuta en paralelo.
- **Crash recovery** — el `resumable` persistido permite que una tarea interrumpida resuma desde su última micro-tarea (no desde cero).

### Notas de implementación
- Scheduler y worker pueden vivir en el mismo proceso demonio, pero son piezas conceptualmente separadas (productor/consumidor).
- El demonio es opt-in (ej. `rei daemon` / `rei schedule add ...`); el CLI interactivo sigue funcionando igual.
- Reusar: persistencia de sesión, plan-tracker, orquestador. No reescribir nada de eso.

---

## 7. Selección dinámica de tools MCP (tool RAG) — mejora futura

> Problema real ya observado (junio 2026): conectar un MCP grande (Google Workspace, ~60-90 tools) infla el array `tools` a ~15-30k tokens. En una ventana local de 32-60k, eso solo ocupa 25-50% del contexto **antes de una palabra de conversación** → overflow / 400 en LM Studio.

### Estado actual (paliativos ya implementados)
- El presupuesto de contexto ahora **cuenta el array `tools`** (`estimateToolsTokens`) → REI recorta historial dejando lugar y avisa si las tools ocupan >40% de la ventana.
- No se duplica la lista de tools MCP en el system prompt del tools path (solo van por el array `tools` de la API).
- Workaround manual: habilitar solo los servicios necesarios por server (`--tools gmail`).

Esto **mitiga** pero no resuelve de raíz: REI sigue mandando TODAS las tools de TODOS los MCP conectados en cada request.

### Cómo lo resuelven los agentes maduros
1. **Ventana gigante** (cloud: 128k-1M) — no aplica a local.
2. **Carga diferida + tool-search** (estado del arte; lo que hace Claude Code): mandar un índice liviano (nombres + 1 línea) + una meta-tool de búsqueda; cargar el schema completo solo on-demand.
3. **RAG de tools / selección dinámica**: embeber las descripciones de las tools y, por turno, recuperar solo el top-K relevante a la query del usuario.

### Propuesta para REI (reusa infraestructura existente)
REI **ya tiene** vector store + embeddings locales (los usa para el repo). Aplicar el mismo mecanismo a las **tools**:
- Al conectar los MCP, embeber `name + description` de cada tool en el VectorStore (namespace aparte).
- Por turno: recuperar el top-K de tools relevantes a `userInput` y mandar **solo ese subconjunto** en el array `tools` (más un set "core" siempre presente: read_files/edit_file/create_file/run_command).
- Resultado: el array `tools` pasa de ~30k a ~3-5k tokens fijos, sin importar cuántos MCP conectes.

### Notas
- Mantener las tools built-in (AGENT_TOOLS) **siempre** en el set; solo las MCP se filtran por relevancia.
- Riesgo: si el top-K no incluye la tool que el modelo necesita → fallback (re-query con más K, o una meta-tool "list_tools" para que pida explícitamente).
- Encaja como capa transversal, independiente del orquestador — sirve tanto al modo interactivo como al autónomo.

---

## 8. Preguntas abiertas (para seguir analizando)

- [ ] Semánticas concretas de unload: ¿Ollama `keep_alive:0` (lazy) vs LM Studio `/unload` (explícito)? ¿endpoint de poll de cargados en cada uno?
- [ ] ¿El denso (27B) y el MoE (30B) caben juntos transitoriamente en 48GB, o el swap final DEBE ser unload-confirmado-then-load? **Escape hatch (C12):** delegar la auditoría MoE a un Nodo que ya lo tenga cargado (registrado en `session.delegations`) evita el swap local por completo.
- [ ] ¿`runMicroTask` reusa `executeAgentTurnWithTools` tal cual, o necesita un wrapper que inyecte el prompt de micro-tarea + abortable signal?
- [ ] Notificación humana en SUSPENDED: ¿`osascript` (notificación macOS nativa) ya disponible en el allow-list del command-executor?
- [ ] Compresión de contexto del sub-loop: ¿resumen por micro-tarea completada, o solo se guarda el diff aplicado?
- [ ] ¿El plan macro reusa el `/runplan` + plan-tracker actuales, o es un formato nuevo?

---

## 9. Historial de cambios

| Versión | Fecha | Qué cambió y por qué |
|---|---|---|
| **v0.1** | 2026-06-13 | Diseño inicial: flujo de orquestación corregido, riesgos, componentes, máquina de estados, capa de scheduling/daemon, tool RAG. |
| **v0.2** | 2026-06-13 | **Alineado con el [plan A2A + OTel](<Multi-Agent A2A + OTel.md>) vía el kernel de ejecución compartido (ADR 0002/0003).** §2 separa el `ExecutionLock` node-wide (lock de tarea) del invariante interno de load/unload de `swapTo`. §3 **define** el `ExecutionLock` (antes ausente pese a declararse DUEÑO). §4 `run()` conforma al seam `RunTask` (`(req, signal) → RunTaskResult`), honra el `signal` del llamador (C10) y marca los puntos de span (IP-3); `OrchestrationSession` gana `delegations` (C7/C12). §6 reencuadra la cola a **tres productores + fast-path** con el demonio como host unificado (serving A2A incluido, C3/IP-6) y `QueuedTask` adopta la forma del contrato (`request` + `resumable`). §8 referencia el escape hatch C12. Back-link al plan A2A en el encabezado. |
