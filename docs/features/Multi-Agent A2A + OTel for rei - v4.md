# Plan: Multi-Agent A2A + OTel for rei (v3)

> Supersedes the detail in the v2 plan; adds the **orchestration model**, the
> **Open/Closed seams**, and a **capability matrix** for multi-agent flows agreed during review.

---

## 1. Context & Goal

rei is a personal AI-agent CLI + HTTP server (TypeScript, pure ESM). We add two capabilities
in vertical slices:

1. **OpenTelemetry** — every rei *turn* emits a trace (root span + per-iteration child spans +
   tool spans) to a self-hosted **Laminar** backend.
2. **A2A** — rei can both **serve** tasks to peer agents and **delegate** to peers, with trace
   context propagating across the boundary so Laminar shows **one unified trace**.

**Demo end state:** a Planner rei and an Auditor rei (same repo, different roles at runtime).
Planner prompt: *"Add a caching layer to the providers. Before planning, ask the auditor to
check if any caching already exists."* → Laminar shows Planner's turn containing Auditor's
turns as child spans.

**Guiding principle (from review): Open/Closed.** The initial build stays simple, but must not
bake in assumptions (single serial client, one fixed orchestrator, sync-only delegation) that
force a rewrite when we scale to concurrent serving, 3+ nodes, or long-running tasks.

---

## 2. Locked Decisions

| Question | Decision |
|---|---|
| A2A host | **Primary `src/server.ts`** (long-running) **+ the CLI serves A2A during its REPL lifecycle**. A2A server is a startable/stoppable component on its own `A2A_PORT`, invoked from both. |
| Token/LLM-token span attrs | **Deferred.** v1 instruments root + turn + tool/delegate spans from data available today. The provider-tracing decorator (IP-4) is the one-file seam to add `usage` later. |
| Peer-agent discovery config | **Extend the existing `ReiConfig`** (`rei.config.json` → `a2aPeers` map), reuse `loadReiConfig`. Same mechanism as MCP servers. |
| Multi-request serving | **Not now**, but the design must not assume serial. Accept/ack is concurrent from day one; execution is a swappable worker count (§4.4). |
| Long-running + deferred join | **Phase 2.** Phase 1 ships bounded-sync delegation; the async/durable path is designed-for, not built (§6). |

---

## 3. Reality Check — v2 assumptions vs the actual code

Each correction is backed by a file:line.

1. **No one-shot `rei "prompt"` mode.** `runCli` ([src/cli/run-cli.ts:8-68](src/cli/run-cli.ts#L8-L68))
   accepts only `plan "<task>"` or `chat` (interactive REPL). All v2 verification commands like
   `rei "list all..."` print *"Unknown command"* — they must be rewritten to `rei chat` / `rei plan` / `rei server`.
2. **CLI is short-lived.** Only the `chat` REPL and `src/server.ts` are long-running → an A2A *server*
   lives for a REPL's duration or inside `rei server` (hence the startable-component design).
3. **Three agent execution paths, not one** (selected in [src/core/agent.ts](src/core/agent.ts)):
   `executeAgentTurnWithTools` (structured, when provider has `completeChatWithTools`,
   [generator-tools.ts:94-365](src/agent-mode/generator-tools.ts#L94-L365)); `executeAgentTurn(Wholefile)`
   (XML fallbacks); and the **ask/planning loop inside `streamTurn` itself** ([agent.ts:418-664](src/core/agent.ts#L418-L664)).
   Spans and `delegate_to_agent` must reach each.
4. **Tool dispatch is duplicated & registry-less** — a `switch` ([generator-tools.ts:233-305](src/agent-mode/generator-tools.ts#L233-L305))
   and `dispatchXmlToolCall` ([action-executor.ts:29-79](src/core/helpers/action-executor.ts#L29-L79)),
   with copy-pasted MCP routing. Adding a tool today means editing both + `AGENT_TOOLS` + the XML prompt.
5. **No provider surfaces token usage** ([model-provider.ts:49-55](src/providers/model-provider.ts#L49-L55)) → token attrs deferred.
6. **`rei.config.json` was removed** (commit `cdeb6a5`) but `loadReiConfig` + `ReiConfig` remain (fall back to `{}`) → extend, don't reinvent.
7. **Pure ESM** (`"type":"module"`, `strict:true`, tsc→`dist/`, `bin/rei.js → import "../dist/main.js"`); **no ESLint** → async-safety rules (`no-floating-promises`, `no-explicit-any`) are manual discipline.
8. **The server already shares one mutable `Agent` + one on-disk session across all requests with no mutex** ([server.ts:46-48](src/server.ts#L46-L48), [chat-handler.ts](src/server/chat-handler.ts)) — it *assumes* a serial client today. A2A must **not** inherit this assumption (§4.4).

---

## 4. Orchestration Model (the mental image)

### 4.1 Role ≠ node
"Orchestrator" is a **per-task role, not a node type**. Every rei is **symmetric** — it can serve
(accept) and delegate (send). Who is "the orchestrator" is just who initiated the current task;
roles can flip task to task. A2A is designed this way (every agent has an Agent Card, is both
client and server). **Code never hardcodes the role** — Planner/Auditor are runtime labels, not types.

### 4.2 Topology: orchestrator–workers tree
Use **orchestrator–workers** (a.k.a. supervisor / agents-as-tools) — the depth-1 case of a
**hierarchical tree**. A worker can itself orchestrate, so depth-N is the *same code*. Decentralized
mesh/handoff is explicitly out of scope (hard to reason about). A2A is only the transport, so this
choice commits us to nothing in the protocol.

### 4.3 Synchronization = local joins only
**There is no global, cross-node synchronization.** Each orchestrator joins only its own direct children.

```
   ┌─ Node A (orchestrator for THIS task) ───────────────────────────┐
   │  agent loop emits delegate calls, then JOINS its children       │
   │   delegate(B) ─▶ Node B        delegate(C) ─▶ Node C            │
   │       │                            └─ (C orchestrates D) ─▶ Node D │
   │       ▼            ▼                                            │
   │   await/join B   await/join C   →  A continues when it has enough│
   └─────────────────────────────────────────────────────────────────┘
   A joins {B,C}.  C independently joins {D}.  Nobody joins the whole tree.
```

Three *local* sync problems, each already solvable:
- **Fan-in / join** — orchestrator awaits multiple children (scatter-gather). The structured path
  already iterates multiple `toolCalls` ([generator-tools.ts:227](src/agent-mode/generator-tools.ts#L227)).
- **Sequential dependency** — await A, then send B with A's result (ordering by data dependency).
- **Correlation** — match reply↔request by **A2A task id**; trace across by **traceparent**.

**Landmine to avoid now:** real cross-node sync (locks/consensus) appears only if two agents mutate
shared state. **Keep workers side-effect-free or workspace-isolated** (the Auditor is read-only) →
the "local joins only" model holds and no distributed-consistency problem arises.

### 4.4 Accept/ack vs execute — the worker-pool seam (OCP)
Split the thing the current server conflates:
- **Accept + acknowledge** — *always* immediate & concurrency-friendly: a peer's task gets a **task id
  + initial state** back at once. Never blocks.
- **Execute** — serialized *today* (because `Agent` isn't concurrency-safe), behind a **queue + worker pool**.

```
A2A server ─submit(task)─▶ [ queue ] ─▶ worker(s) ─▶ dedicated Agent.runTurn
   │ returns {id, state:submitted}        concurrency = 1 today / N later
   ▼
 peer gets an ACK instantly
```

The protocol surface is multi-request from day one; "serial" is just `concurrency = 1`, a number — not
an assumption in the code. Becoming concurrent later = raise the number + guarantee per-task isolation;
**the A2A layer is untouched.** The per-task isolation requirement: the A2A server owns a **dedicated
`Agent` + fresh `ChatSession` per task** (never the interactive one, whose per-turn mutable state —
`correlationId`, `pendingHardwareWarnings`, per-turn logger — would be clobbered).

### 4.5 2→3→N nodes = config, not refactor
Three properties we honor now: **symmetry** (every node serves + delegates), **recursion** (a worker
is also an orchestrator → depth for free), **peers in config** (`a2aPeers` map). Adding node 3 = one
config line; the orchestration graph is emergent at runtime, never enumerated in code.

---

## 5. Task lifecycle & A2A primitives

| Need | A2A answer | Note |
|---|---|---|
| **Ack** | `message/send` returns a `Task{id, state: submitted/working}` | the id is the handle for everything after |
| **Heartbeat ("alive but busy")** | `message/stream` (SSE) streams `TaskStatusUpdateEvent`s; `tasks/get` polls | rei already does SSE keepalive (`: heartbeat` every 10s, [server.ts:111-113](src/server.ts#L111-L113)) |
| **Long-running (hours)** | **push notifications** (`tasks/pushNotificationConfig/set`, webhook callback) + `tasks/get` + `tasks/resubscribe` | the standard async request-reply / LRO pattern — don't hold a connection |
| **Parent keeps control / alt paths** | **deadline + `tasks/cancel`**; the agent loop chooses another path on timeout/pending | every delegation is bounded (AbortController, like the 15s MCP timeout [http-client.ts:91-106](src/tools/mcp/http-client.ts#L91-L106)) |

⚠️ Push-notification support varies by SDK version — **verify the installed `@a2a-js/sdk` surface**
before relying on it. For the demo only bounded-sync is required.

---

## 6. Capability Matrix — reference scenario

**Scenario:** Initiator **I** delegates to **A** (short, independent), **B** (short, independent),
**C** (long-running); I joins A+B → derives **D**; finally **combine(D, C)**.

```
t0  I emits delegate(A), delegate(B), delegate(C)
       A ─short┐   B ─short┐   C ──────long (hours)──────┐
t1  I has A,B ─▶ do D (D depends on A+B)                  │
t2  ... I free, C still pending — must not block ...      ▼
t3  C done ─▶ combine(D, C) ─▶ final
```

The boundary falls on the long pole:

### Phase 1 — bounded orchestration (in scope / ~out-of-the-box)
Everything that completes inside **one bounded reasoning episode** (≤ `MAX_TURNS`):

| Capability | Status |
|---|---|
| Sequential delegate + use result | ✅ today (loop awaits tool → feeds back → continues) |
| Multiple delegations in one turn (A,B) | ✅ today, but **serial** (toolCalls iterated) |
| **Parallel** A‖B | 🟡 one-line change: `for`-await → `Promise.allSettled` in the dispatcher |
| Bounded-sync delegation (A,B) with deadline | ✅ via new `delegate_to_agent` + AbortController |
| Fan-in join A+B → derive D | ✅ (D = orchestrator's own next step after both results return) |
| Unified cross-agent trace | ✅ by design (traceparent) |

→ **The entire A,B→D half is Phase-1 scope.**

### Phase 2 — durable async (needs a subsystem)
Anything that must **survive the episode** (C, and combine(D,C)):

| Gap | Requires |
|---|---|
| Non-blocking delegation (fire C, don't await) | **async delegate**: send → return task id immediately (A2A ack), don't hold the turn |
| Partial join (proceed on A+B while C pends) | orchestrator **tracks outstanding task ids**; model polls via `check_delegation(id)` |
| Deferred join / resume hours later (combine D,C) | **durable, resumable orchestration state** + resume entry point — a real subsystem |

The durable subsystem (Phase 2): (1) a **pending-task store** persisting `{taskId, peer, partial
results (D), what-to-do-on-complete}`; (2) a **completion trigger** (A2A push-notification webhook or
poller); (3) a **resume handler** re-entering the agent with seeded context (*"C done = …; you produced
D = …; now combine"*); (4) cancel/timeout policy. Known art: durable execution (Temporal / Inngest /
Restate) or a homegrown task table — a *solved category*, not bespoke, but deliberate Phase-2 work.

### The delegate contract = the OCP boundary
Define both modes from day one; implement only the first:
- `delegate_to_agent(peer, prompt)` → **bounded-sync**. Build now. Powers A, B, D.
- `delegate_async(peer, prompt)` → returns **task id**; `check_delegation(id)` → `working | done | failed`.
  Define the seam now (may return `pending`), back it with the durable store later. Powers C.

Both ride the **same `TaskExecutor` + A2A task id** underneath, so adding the durable backend never
touches the sync tool, the dispatcher, or the protocol layer.

---

## 7. Integration Points — architectural & extensibility

- **IP-1 Telemetry bootstrap** — `src/telemetry/init.ts`, imported first by `main.ts`/`server.ts`.
  *ESM:* manual spans work with a top-of-file import; **auto-HTTP instrumentation needs a loader/`--import`
  hook** → v1 uses **manual spans only** (provider decorator). `init.ts` owns SDK lifecycle + `shutdownTelemetry()`.
- **IP-2 Root span** — wrap `Agent.runTurn`/`streamTurn` ([agent.ts:135](src/core/agent.ts#L135), [:177](src/core/agent.ts#L177)).
  Both CLI and server funnel here. Unit = **one user prompt = one root span** (not per process). Attrs:
  `rei.mode`, `rei.provider`, `rei.correlation_id`, `rei.workspace`.
- **IP-3 Turn spans** — one `withTurnSpan(n, attrs, fn)` helper called at each of the three loop heads.
- **IP-4 LLM-call span** — **wrap the `ModelProvider` once** in `provider-factory` with `withTelemetry(provider)`
  (one file, all providers, and the **future token-usage seam**) — not 6 call sites.
- **IP-5 Tool span + `delegate_to_agent`** — extract one `dispatchBuiltinTool(name, args, ctx)` in
  `src/agent-mode/tool-dispatch.ts` shared by both dispatch paths (de-dupes MCP routing, hosts delegate
  + tool spans). Minimal fallback exists but the unify pays off at tool #3.
- **IP-6 A2A server** — `startA2AServer({ workspacePath, port }): { close() }`, started from `server.ts`
  and `run-chat.ts`/`run-cli.ts` finally. **Dedicated Agent + fresh session per task + queue/worker
  (concurrency 1)** (§4.4). Runs on its own `A2A_PORT` via the SDK's Express app (rei's server is raw
  `node:http`; don't graft A2A onto `/chat/completions`).
- **IP-7 A2A client + delegation** — `src/a2a/client.ts` (`sendTask`), bounded by AbortController; reads
  peer URL from `ReiConfig.a2aPeers`. Depends on a narrow `RunTask` contract, **not** Agent internals.
- **IP-8 Config** — extend `ReiConfig` with `a2aPeers?: Record<string,string>` + `getA2APeers()`, reuse `loadReiConfig`.
- **IP-9 Context propagation** — `src/telemetry/a2a-propagation.ts` inject/extract over `Message.metadata`.
  **Load-bearing assumption:** metadata survives the round trip into the executor's `RequestContext` — spike first.

**Extensibility scorecard (recommended seams):**

| Concern | Quick hack | Extensible seam |
|---|---|---|
| LLM spans / future tokens | edit 6 providers | **`withTelemetry(provider)` decorator** |
| New tools (delegate + later) | edit 2 dispatchers + prompt | **`dispatchBuiltinTool()`** |
| Turn spans | 3× inline | **`withTurnSpan()`** |
| A2A serving + concurrency | per-process glue / mutex baked in | **`startA2AServer()` + `TaskExecutor` queue (concurrency = N)** |
| Delegation sync→async | rewrite the tool | **`delegate_to_agent` + `delegate_async` on one TaskExecutor** |
| 2→3→N nodes | new code per node | **symmetry + recursion + `a2aPeers` config** |

---

## 8. Implementation Phases

**Phase 0 — Doc:** create this file under `docs/features/`.

**Iteration 1 — OTel + Laminar (Days 1-2).** Create `telemetry/init.ts` (+`shutdownTelemetry`),
`telemetry/spans.ts` (`withTurnSpan`), `withTelemetry(provider)` in `provider-factory`. Modify
`main.ts`/`server.ts` (first-import), `Agent.runTurn`/`streamTurn` (root span), the three loops (turn
spans). Register flush on `SIGINT`/`beforeExit`. Gate exporters off under test (`OTEL_SDK_DISABLED`).
Verify: `docker compose up -d`; `rei chat` → Laminar shows `rei.turn` root + `turn-N` children.

**Iteration 2 — A2A server (Days 3-4).** Create `a2a/server.ts` (`startA2AServer`, AgentCard skill
`run_task`, `AgentExecutor`, **dedicated Agent + queue/worker(1) + fresh session per task**), `a2a/types.ts`
(incl. `RunTask`). Modify `server.ts` + `run-chat.ts`/`run-cli.ts` to start/close. Install `@a2a-js/sdk` (+`express`).
Verify with a real A2A client (not v2's `curl /tasks`): `A2A_PORT=7778 rei server` → send → result + new trace.

**Iteration 3 — Delegation, bounded-sync (Days 5-6).** Create `a2a/client.ts`, `agent-mode/tool-dispatch.ts`
(unified), `DELEGATE_TO_AGENT_TOOL`. Extend `ReiConfig.a2aPeers` + `rei.config-example.json`. Both paths
call `dispatchBuiltinTool`; advertise the tool in the XML prompt. (Optional: parallel fan-out via
`Promise.allSettled`.) Verify Planner→Auditor; two traces.

**Iteration 4 — Cross-agent trace (Days 7-8).** `telemetry/a2a-propagation.ts`; client injects traceparent
into `message.metadata`, server extracts → root span as child. **Pre-req: IP-9 spike green.** Verify: one trace.

**Iteration 5 — Demo polish (Days 9-10).** Tool/`a2a.*` span attrs; `docs/demo/planner-auditor.md` runbook
(corrected commands); update `docs/features/multi-agent.md`. Token attrs stay deferred (note the seam).

**Phase 2 (future, not now):** durable async — `delegate_async`/`check_delegation`, pending-task store,
push-notification webhook + resume handler, `tasks/cancel`. Enables the C / combine(D,C) flow (§6).

---

## 9. Unsolved Points / Warnings

1. **A2A `metadata` pass-through is load-bearing & unverified** — the whole unified trace depends on
   `@a2a-js/sdk` preserving `Message.metadata` into the executor's `RequestContext`. **Spike before iter 4.**
   Fallback: custom A2A extension or an HTTP header carrier.
2. **`Agent` is not concurrency-safe** (per-turn mutable state + in-place session mutation). Mitigation:
   dedicated A2A Agent + fresh session per task + worker concurrency = 1. True parallel serving needs a
   turn-stateless `Agent` — Phase 2 debt.
3. **Spans lost on `process.exit`** — many `process.exit(1)` paths drop buffered spans. Use
   `SimpleSpanProcessor` for the demo or `await shutdownTelemetry()` before deliberate exits + on SIGINT.
4. **v2's A2A SDK shape is fictional** — `sendTask({skill,input})` / `POST /tasks` is not the protocol.
   Real: AgentCard + AgentExecutor + DefaultRequestHandler + A2AExpressApp; client `sendMessage({message:{parts,metadata}})`;
   JSON-RPC `message/send`/`message/stream`. Rewrite all A2A pseudocode against the installed version.
5. **Laminar ports/version unverified** — confirm image version + compose ports (needs postgres + clickhouse).
6. **ESM blocks OTel HTTP auto-instrumentation** — v1 uses manual spans; don't promise auto-capture.
7. **Tests hit the exporter** — gate with `OTEL_SDK_DISABLED=true` under Vitest.
8. **Edit-format coverage** — `delegate_to_agent` must work on the demo provider's path; do the unified
   dispatcher (IP-5) or confirm the path to avoid "works on my model".
9. **MCP context budget** — new tool schemas add to the >40% context warning ([agent.ts:863-870](src/core/agent.ts#L863-L870)); keep schemas lean.
10. **Long-running orchestration is Phase 2** — Phase 1 cannot do the C / deferred-join half (§6); don't
    let the demo imply it can.

---

## 10. Critical Files

| File | Action |
|---|---|
| `docs/features/Plan: Multi-Agent A2A + OTel for rei (v3).md` | **Create — this document** |
| `src/telemetry/init.ts`, `spans.ts`, `a2a-propagation.ts` | Create — SDK bootstrap, `withTurnSpan`, inject/extract |
| `src/providers/provider-factory.ts` | Modify — `withTelemetry(provider)` (IP-4) |
| `src/core/agent.ts` | Modify — root span (`runTurn`/`streamTurn`) + turn spans |
| `src/agent-mode/generator-tools.ts`, `generator.ts` | Modify — turn spans; route via unified dispatcher |
| `src/agent-mode/tool-dispatch.ts` | Create — unified built-in dispatcher + tool spans (IP-5) |
| `src/core/helpers/action-executor.ts` | Modify — XML path calls unified dispatcher |
| `src/contracts/tool-definitions.ts` | Modify — `DELEGATE_TO_AGENT_TOOL` (+ later `delegate_async`) |
| `src/a2a/server.ts`, `client.ts`, `types.ts` | Create — serve/delegate (real SDK), `RunTask`, `TaskExecutor` queue |
| `src/server.ts`, `src/cli/run-chat.ts`, `run-cli.ts` | Modify — start/close A2A component |
| `src/tools/mcp/mcp-config.ts` | Modify — `ReiConfig.a2aPeers` + `getA2APeers()` |
| `src/main.ts` (+ `bin/rei.js` only if auto-instrumentation) | Modify — first-import telemetry |
| `rei.config-example.json`, `.env.example`, `docker-compose.yml` | Modify/Create — `a2aPeers`, `OTEL_*`, `A2A_PORT`, Laminar |
| `docs/demo/planner-auditor.md`, `docs/features/multi-agent.md` | Create/Update — runbook |

---

## 11. Verification (final demo)

1. `docker compose up -d` → Laminar reachable.
2. Terminal A: `A2A_PORT=7778 rei server` (Auditor; read-only worker).
3. Terminal B: `rei chat` with `rei.config.json` `a2aPeers.auditor = http://localhost:7778`, prompt:
   *"Add a caching layer to the providers. Before planning, ask the auditor to check if any caching already exists."*
4. Laminar: **one** trace — Planner root → `turn-N` → `tool.delegate_to_agent` → Auditor root (child) →
   Auditor `turn-M` → `llm-call`. `traceparent` visible on the A2A message.
5. `npm run check` and `npm test` green (telemetry gated off under test).
