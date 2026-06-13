# Plan: Multi-Agent A2A + OTel for rei (v6)

> Builds on v5. **v6 aligns the A2A + OTel plan with the hardware-aware
> [Orchestration plan](rei-plan-orchestration.md)** so the two compose instead of colliding.
> It reports the incompatibilities, resolves them through one **shared execution kernel**, and
> defines the seam interfaces so either effort can be built first.
> Glossary: [CONTEXT.md](../../CONTEXT.md). Decisions: [ADR 0001](../adr/0001-a2a-serving-concurrency.md),
> [ADR 0002](../adr/0002-single-model-execution-lock.md). Evolution: **§14 Change History**.

---

## 1. Context & Goal

rei gains two capability families that turn out to be **two halves of one system**:

- **A2A + OTel** (this plan) — rei is an **A2A Node** that **serves** delegated tasks and **delegates**
  to other Nodes, with trace context propagating so Laminar shows **one unified trace**.
- **Orchestration** ([sister plan](rei-plan-orchestration.md)) — an opt-in **Orchestrator Engine**
  (`/auto`) that runs long, hardware-constrained work on one Node: macro→micro decomposition, AST-validated
  apply, model-lifecycle/thermal management, and a scheduling **daemon**.

**The aligning insight:** the orchestration plan proves you **cannot parallelize heavy work on one
machine** (one ~20 GB model at a time in 48 GB; swap races crash). So the only way to scale is **delegate
to another Node** — A2A. And the *durable async delegation* this plan deferred to "Phase 2" **is** the
orchestration plan's persistent queue + resumable session. **Build that kernel once; both features use it.**

**Principles:** **OCP** (stay simple, don't bake in assumptions that force a rewrite) and **SRP**
(each Node does one job; one Node, one Worker, one task at a time).

**Canonical terms** (see [CONTEXT.md](../../CONTEXT.md)): **Turn**/**Step** (span units),
**A2A Node** (any A2A participant), **Identity** (self-declared, SRP) vs **Role**, **Director**/**Worker**
(A2A Roles), **Orchestrator Engine** (single-node `/auto` component), **Macro-Stage**/**Micro-Task**.

---

## 2. Alignment with the Orchestration Plan (the heart of v6)

### 2.1 Incompatibilities found, and how v6 resolves them

| # | Incompatibility | Sev | Resolution in v6 |
|---|---|---|---|
| C1 | "Orchestrator"/"Worker" meant a Role *and* a component | 🟡 | Glossary split: **Director/Worker** = A2A Roles; **Orchestrator Engine** = the `/auto` component (§ CONTEXT.md). |
| C2 | A2A serving mutex **vs** model-lifecycle lock → double model load → crash | 🔴 | **One node-wide Model/Execution Lock** for every trigger ([ADR 0002](../adr/0002-single-model-execution-lock.md)). |
| C3 | Two queues + two "single workers" | 🔴 | **One persistent queue + one Worker**; A2A-inbound long tasks **enqueue** into it. |
| C4 | v5 "concurrency = N later" vs single-heavy-model reality | 🟡 | **N = 1 per Node, permanently.** Concurrency = **scale-out via A2A**, never parallel-local. |
| C5 | v5 synchronous serving vs daemon's async queue | 🟡 | **Sync fast-path** (short tasks) **+ enqueue** (long tasks = async/durable). |
| C6 | `withTelemetry(provider)` would **shadow** `loadModel/unloadModel/isModelLoaded` → breaks model swap | 🔴 | Decorator **forwards all optional methods** and traces swaps as spans (IP-4). |
| C7 | Durable run-state defined twice | 🟢 | **One resumable session** (orchestration session); A2A delegation handles are entries in it. |
| C8 | OTel spans ignore orchestration | 🟡 | Extend hierarchy: **Orchestration → Macro-Stage → Micro-Task (≈ Turn) → Step → {llm-call, ast-validate, git-checkpoint, model-swap, cooling}**. |
| C9 | Process-mode sprawl (chat/server/daemon/auto) | 🟡 | The **daemon** is the unified long-running host (scheduler + queue + Worker + Lock + **A2A serving**). |
| C10 | A2A `tasks/cancel` vs Watchdog suspend/abort | 🟡 | A2A cancel → the run's **AbortController/Watchdog**. |
| C11 | Remote cold-load not in deadlines | 🟡 | Deadlines/heartbeats budget the Worker's cold-load (why the A2A "alive but busy" heartbeat matters). |
| C12 | — (latent synergy) | 🟢 | **Delegate the MoE step to a Node that already has it loaded → skip the local dense→MoE swap.** A2A *optimizes* orchestration. |

### 2.2 The shared execution kernel

```
        triggers                       ┌──────────────── one Node ────────────────┐
  interactive (chat) ───┐              │   ┌──── Model/Execution Lock (N=1) ────┐  │
  A2A-inbound (Worker) ─┼─► enqueue ──►│   │  single Worker drains the queue    │  │
  scheduled (daemon)  ──┘   OR sync    │   │     └─ RunTask(req, signal)         │  │
                            fast-path  │   │           ├─ plain Agent Turn       │  │
                                       │   │           └─ Orchestrator Engine    │  │
                                       │   └────────────────────────────────────┘  │
                                       └──── persistent queue + resumable session ──┘
```

### 2.3 Seam interfaces (the integration contract — either plan can build first)

```typescript
// What the Worker runs. Phase 1 impl = plain Agent Turn; /auto impl = Orchestrator Engine.
type RunTask = (req: { prompt: string; workspacePath: string; meta: A2AMeta },
                signal: AbortSignal) => Promise<{ text: string }>;

// One per Node. Phase 1 = in-process async mutex; later = the model-lifecycle lock (ADR 0002).
interface ExecutionLock { acquire(signal: AbortSignal): Promise<() => void>; }

// One per Node. Phase 1 = minimal (in-memory + simple disk); later = the daemon's persistent queue.
interface TaskQueue {
  enqueue(item: QueuedTask): void;
  claimNext(): QueuedTask | null;        // marks running, atomic
  complete(id: string, state: QueuedTaskState): void;
}

// Trace + safety context carried across A2A (alongside W3C traceparent).
interface A2AMeta { traceparent?: string; "a2a.depth"?: number; }
```

**Why this integrates cleanly:** A2A serving calls `ExecutionLock` + `TaskQueue` + `RunTask`. Today
`RunTask` = a plain Agent Turn and the lock/queue have trivial implementations — **it works without the
Orchestrator Engine existing**. When `/auto` lands, `RunTask` becomes the Orchestrator Engine and the
lock/queue become the daemon's real ones — **A2A serving code does not change.** Same the other way:
the daemon can be built first; A2A serving just becomes another producer into its queue.

---

## 3. Locked Decisions (v6 delta over v5 in **bold**)

| Question | Decision |
|---|---|
| A2A host | **The daemon (`rei daemon`) is the unified long-running host** (scheduler + queue + Worker + Lock + A2A serving). `rei server` keeps the OpenAI-compat endpoint; `rei chat` stays interactive. |
| Trace units | **Turn = root span** (`rei.turn`); **Step = child** (`step-N`). **Orchestration runs add Macro-Stage / Micro-Task spans above Turn** (§ IP-3). |
| Serving concurrency | **One Model/Execution Lock + one Worker + one queue; N=1 per Node; concurrency = scale-out via A2A** ([ADR 0001](../adr/0001-a2a-serving-concurrency.md), [ADR 0002](../adr/0002-single-model-execution-lock.md)). |
| Delegation latency | **Sync fast-path for short tasks + enqueue for long** (the enqueue path = durable async = orchestration session). |
| Provider decorator | `withTelemetry(provider)` **forwards `loadModel/unloadModel/isModelLoaded`** and traces swaps. |
| Node discovery config | `ReiConfig.a2aNodes` map (`label → URL`), reuse `loadReiConfig`. |
| Worker safety | Phase 1 convention + documented gap; Phase 2 capability profile (§9). |
| Delegation safety | Phase 1 propagated **delegation-depth cap** in A2A metadata; origin cycle detection deferred. |
| Token attrs | Deferred (the decorator is the seam). |
| Span processor | `SimpleSpanProcessor` for the demo. |

---

## 4. Reality Check (unchanged from v5, terminology updated)

No one-shot `rei "prompt"` mode; CLI short-lived; three agent execution paths; duplicated registry-less
tool dispatch; no provider token usage; `rei.config.json` removed but `loadReiConfig` remains; pure ESM /
`strict` / no ESLint; the HTTP server already shares one mutable `Agent` serially; **mode alone does not
make a Worker read-only** (`run_command` mutates even in `ask`). See v5 §3 for file:line backing.

---

## 5. Multi-Agent Model (Director/Worker)

- **Identity (self-declared, SRP) vs Role (emergent).** A Node knows what it *is*; its **Director/Worker**
  Role is per-task. A **Worker may execute its task via the Orchestrator Engine** or a plain Turn.
- **Local joins only** — each Director joins its own direct children (fan-in, sequential dependency,
  correlation by A2A task id, trace by traceparent). No global cross-node sync.
- **Delegation-depth cap** — `a2a.depth` propagated in metadata; refuse-and-degrade past max (default 3).
- **2 → N nodes = config** — symmetry + recursion + `a2aNodes`. Scaling out is the *only* concurrency.

---

## 6. Task Lifecycle & A2A Primitives (unchanged from v5)

Ack = `Task{id,state}`; heartbeat = streamed `TaskStatusUpdateEvent` / `tasks/get` (**must cover remote
cold-load latency**, C11); long-running = push notifications + poll (**Phase 2 = the shared durable
queue**); control = deadline + `tasks/cancel` → AbortController/Watchdog (C10). Verify installed
`@a2a-js/sdk` surface.

---

## 7. Capability Matrix (Phase 1 vs Phase 2)

**Phase 1 — bounded:** sequential/parallel delegate, fan-in join, bounded-sync delegation, unified trace.
**Phase 2 — durable async:** non-blocking delegation, partial join, deferred join — **delivered by the
shared kernel's persistent queue + resumable session** (same subsystem the daemon needs). The OCP boundary
is still `delegate_to_agent` (sync) vs `delegate_async` + `check_delegation` (async), both over the same
`TaskExecutor`/queue.

---

## 8. Integration Points (v6 updates marked ▲)

- **IP-1 Telemetry bootstrap** — `telemetry/init.ts`, first import, `SimpleSpanProcessor`, manual spans.
- **IP-2 Root span (Turn)** — wrap `Agent.runTurn`/`streamTurn`. One prompt = one `rei.turn`.
- ▲ **IP-3 Step + Orchestration spans** — `withStepSpan` at each loop head; **and** `withStageSpan` /
  `withMicroTaskSpan` so an `/auto` run nests **Orchestration → Macro-Stage → Micro-Task → Turn → Step**.
  Add spans for `ast-validate`, `git-checkpoint`, `model-swap`, `cooling` (C8).
- ▲ **IP-4 LLM-call span + lifecycle passthrough** — `withTelemetry(provider)` wraps chat methods **and
  forwards `loadModel/unloadModel/isModelLoaded`**, emitting a `model-swap` span around load/unload (C6).
- **IP-5 Tool span + `delegate_to_agent`** — one `dispatchBuiltinTool`; tool description lists `a2aNodes`.
- ▲ **IP-6 A2A serving via the kernel** — `startA2AServer` no longer owns a private mutex; it **acquires
  the node `ExecutionLock` and uses the shared `TaskQueue` + `RunTask`** (C2, C3). Hosted by the daemon.
- ▲ **IP-7 A2A client** — `sendTask` bounded by AbortController, increments `a2a.depth`, **budgets remote
  cold-load in its deadline** (C11); reads `ReiConfig.a2aNodes`.
- **IP-8 Config** — `ReiConfig.a2aNodes` + `getA2ANodes()`.
- **IP-9 Context propagation** — `a2a-propagation.ts` over `Message.metadata` (carries `traceparent` +
  `a2a.depth`). Load-bearing; spike first.

---

## 9. Security Posture (unchanged from v5)

Phase 1: a served task runs full-capability — **read-only is convention, not enforced** (`run_command`
mutates even in `ask`). Trusted Nodes only. Phase 2: **capability profile** per Node (restricted tool set),
declared in the AgentCard. Depth cap is the Phase-1 runaway guard; SRP keeps capabilities narrow.

---

## 10. Implementation Phases — reordered by coupling

Build order is now driven by **coupling to rei's evolving core**, gated by the
**[Plan Integration Contract](plan-integration-contract.md)**
([`src/contracts/execution-contract.ts`](../../src/contracts/execution-contract.ts), [ADR 0003](../adr/0003-plan-integration-contract.md)).
Everything that speaks only the contract builds **now**; only the glue waits for rei's final structure.

**Wave 1 — Contract + behind-the-firewall modules (now; rei-structure-independent):**
- `src/contracts/execution-contract.ts` — the contract (imports nothing from rei). **Done.**
- `telemetry/{init,spans,a2a-propagation}.ts` — `SimpleSpanProcessor`; span helpers over `SpanName`; W3C inject/extract.
- `ExecutionLock` + `TaskQueue` **minimal** impls (in-process mutex; in-memory/simple-disk queue).
- `a2a/server.ts` — `startA2AServer({ runTask, lock, queue, card })`; seam **injected**, **never imports `Agent`**.
- `a2a/client.ts` — `sendTask` (depth cap + cold-load-aware deadline), reads `a2aNodes`.
- `withTelemetry(provider)` — wraps the `ModelProvider` interface, **forwards `ModelLifecycle`**, emits `model-swap` span.
- `ReiConfig.a2aNodes` (imports `A2ANodeMap`) + `getA2ANodes()`; `docker-compose.yml`.
- All unit-tested against a **mock `RunTask`**. Install `@a2a-js/sdk` (+express), `@opentelemetry/*`.

**Wave 2 — Glue (when rei's structure settles):**
- `RunTask` adapter → `agent.runTurn` (today) / Orchestrator Engine (later).
- Root/Step span instrumentation in `agent.ts` + the three loops; Orchestration/Macro/Micro spans.
- Unified `dispatchBuiltinTool` + `delegate_to_agent` wiring; start A2A serving from `rei server` → `rei daemon`.

**Convergence:** the Orchestration plan supplies the real `RunTask` (Orchestrator Engine), `ExecutionLock`
(model lock) and `TaskQueue` (durable daemon queue) — **Wave-1 code binds to them unchanged.**

---

## 11. Unsolved Points / Warnings

Carried from v5 (A2A metadata pass-through; `Agent` not concurrency-safe; spans on exit; verify SDK shape;
Laminar ports; ESM auto-instrumentation; tests hit exporter; edit-format coverage; MCP budget; deliberate
security gap; long-running = Phase 2). **New in v6:**

- **The kernel seam must be agreed by both plans before coding** — if A2A serving keeps a private mutex
  (v5) it will fight the model lock (C2). Land `ExecutionLock`/`TaskQueue`/`RunTask` first.
- **Decorator-vs-lifecycle (C6)** is silent if missed — add a test that the wrapped provider still exposes
  `loadModel/unloadModel/isModelLoaded`.
- **Remote cold-load (C11)** — a sync delegation's deadline must exceed the Worker's worst-case model load,
  or short delegations spuriously time out.

---

## 12. Critical Files (v6 delta over v5)

| File | Action |
|---|---|
| `docs/adr/0002-single-model-execution-lock.md` | Create — the shared-lock decision |
| `src/exec/kernel.ts` (new) | Create — `ExecutionLock`, `TaskQueue`, `RunTask` seam (minimal Phase-1 impls) |
| `src/providers/provider-factory.ts` | Modify — `withTelemetry` **forwards lifecycle methods** + `model-swap` span |
| `src/telemetry/spans.ts` | Create — `withStepSpan` + `withStageSpan`/`withMicroTaskSpan` (stubs) |
| `src/a2a/server.ts` | Create — uses kernel (lock + queue + `RunTask`), **no private mutex** |
| `src/a2a/client.ts`, `types.ts` | Create — `sendTask` (depth cap, cold-load deadline), `A2AMeta` |
| _(rest as v5 §11)_ | telemetry init, agent.ts spans, tool-dispatch, ReiConfig.a2aNodes, docker-compose, etc. |

---

## 13. Verification (final demo, unchanged scenario)

`docker compose up -d`; Auditor `rei server` (later `rei daemon`); Planner `rei chat` with
`a2aNodes.auditor`. One Laminar trace: Planner `rei.turn` → `step-N` → `tool.delegate_to_agent` →
Auditor `rei.turn` (child) → `step-M` → `llm-call`; `traceparent`+`a2a.depth` on the message.
`npm run check` && `npm test` green. **Kernel check:** running the same task via interactive, A2A-inbound,
and (stub) scheduled triggers all serialize behind the one lock.

---

## 14. Change History

| Version | Date | What changed & why |
|---|---|---|
| **v1** | 2026-06-12 | Standalone MVP (separate packages; prove `traceparent` across two A2A agents into one Laminar trace). |
| **v2** | 2026-06-12 | First rei-integrated 10-day plan; Planner/Auditor demo, `A2A_PORT` sidecar, `agents` config. Several wrong assumptions. |
| **v3** | 2026-06-12 | Reality-check vs the code; Integration Points IP-1…IP-9; extensibility scorecard; unsolved points. |
| **v4** | 2026-06-13 | Orchestration model: role≠node, orchestrator-workers tree, local-joins sync, accept/ack-vs-execute OCP seam, capability matrix, delegate sync/async boundary. |
| **v5** | 2026-06-13 | Grilled terminology ([CONTEXT.md](../../CONTEXT.md)): Turn/Step, A2A Node (impl-agnostic), Identity vs Role, SRP. Serving model + [ADR 0001](../adr/0001-a2a-serving-concurrency.md); read-only = convention + documented gap; delegation-depth cap; `SimpleSpanProcessor`; `a2aPeers`→`a2aNodes`. |
| **v6** | 2026-06-13 | **Aligned with the [Orchestration plan](rei-plan-orchestration.md).** Terminology de-collided (**Director**/Worker vs **Orchestrator Engine**, Macro-Stage/Micro-Task). Resolved blockers via **one shared execution kernel** — single **Model/Execution Lock** ([ADR 0002](../adr/0002-single-model-execution-lock.md)), one queue + one Worker, `RunTask` seam targeting Agent-Turn-or-Orchestrator-Engine. Reframed concurrency to **N=1 local / scale-out via A2A**; daemon as unified host; sync fast-path + enqueue; `withTelemetry` **forwards model-lifecycle**; extended spans to Orchestration/Macro/Micro; A2A as a **swap-cost optimization** for orchestration (C12). Defined seam interfaces so either plan can be built first. |
