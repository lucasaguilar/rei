# Plan: Multi-Agent A2A + OTel for rei (v5)

> Builds on v4. v5 is the **grilled** edition: terminology sharpened against a new project
> glossary ([CONTEXT.md](../../CONTEXT.md)), the orchestration model hardened, and several
> load-bearing-but-unenforced assumptions turned into explicit decisions. See **§13 Change History**
> for how the plan evolved v1 → v5, and [ADR 0001](../adr/0001-a2a-serving-concurrency.md) for the
> serving-concurrency decision.

---

## 1. Context & Goal

rei is a personal AI-agent CLI + HTTP server (TypeScript, pure ESM). We add two capabilities,
delivered in vertical slices:

1. **OpenTelemetry** — every **Turn** emits a trace (root span + per-**Step** child spans + tool
   spans) to a self-hosted **Laminar** backend.
2. **A2A** — rei becomes an **A2A Node** that can both **serve** delegated tasks and **delegate** to
   other Nodes, with trace context propagating across the boundary → **one unified trace** in Laminar.

**Demo end state:** a Planner rei Node and an Auditor rei Node (same repo). Planner prompt:
*"Add a caching layer to the providers. Before planning, ask the auditor to check if any caching
already exists."* → Laminar shows the Planner's Turn containing the Auditor's Steps as child spans.

**Guiding principles:**
- **Open/Closed (OCP)** — the initial build stays simple but must not bake in assumptions (serial
  client, fixed orchestrator, sync-only delegation) that force a rewrite to scale.
- **Single Responsibility (SRP)** — each Node has one focused responsibility (its Identity); it does
  one job well rather than being a general-purpose mega-agent.

**Canonical language:** see [CONTEXT.md](../../CONTEXT.md). Key terms used below: **Turn** (one
prompt↔response exchange = root span), **Step** (one loop iteration = child span), **A2A Node**
(any A2A participant, rei or otherwise), **Identity** (a Node's self-declared single responsibility),
**Role** (Orchestrator/Worker — emergent, per-task).

---

## 2. Locked Decisions

| Question | Decision |
|---|---|
| A2A host | **Primary `src/server.ts`** (long-running) **+ the CLI serves A2A during its REPL lifecycle**. Startable/stoppable component on its own `A2A_PORT`, invoked from both. |
| Trace units | **Turn = root span** (`rei.turn`, one per user prompt); **Step = child span** (`step-N`, one loop iteration). Retires the v1–v4 "turn"-for-both overload. |
| Token / LLM-token span attrs | **Deferred.** The `withTelemetry(provider)` decorator (IP-4) is the one-file seam to add `usage` later. |
| Node discovery config | **Extend `ReiConfig`** with an **`a2aNodes`** map (`label → URL`), reuse `loadReiConfig`. (Renamed from v3/v4's `a2aPeers` now that we use one term, "Node".) |
| Serving concurrency | **One dedicated serving Agent per Node + fresh session per task + mutex (serial, synchronous)** in Phase 1; async/queue/`N` workers in Phase 2. → [ADR 0001](../adr/0001-a2a-serving-concurrency.md). |
| Worker safety (read-only) | **Phase 1: convention only + documented security gap.** Phase 2: **capability profile** restricting the served tool set. |
| Delegation safety | **Phase 1: propagated delegation-depth cap** (refuse-and-degrade past max), carried in A2A metadata next to `traceparent`. Origin-based cycle detection deferred. |
| Long-running + deferred join | **Phase 2.** Phase 1 ships bounded-sync delegation only (§6). |
| Span processor | **`SimpleSpanProcessor` for the demo** (no lost spans on `process.exit`); revisit batching later. |

---

## 3. Reality Check — earlier assumptions vs the actual code

Each correction is backed by a file:line.

1. **No one-shot `rei "prompt"` mode.** `runCli` ([run-cli.ts:8-68](src/cli/run-cli.ts#L8-L68)) accepts
   only `plan "<task>"` or `chat` (interactive REPL). v2's `rei "list all..."` commands print
   *"Unknown command"* — all verification must use `rei chat` / `rei plan` / `rei server`.
2. **CLI is short-lived.** Only the `chat` REPL and `src/server.ts` are long-running → an A2A *server*
   lives for a REPL's duration or inside `rei server` (hence the startable-component design).
3. **Three agent execution paths**, selected in [agent.ts](src/core/agent.ts): `executeAgentTurnWithTools`
   (structured, when the provider has `completeChatWithTools`); `executeAgentTurn(Wholefile)` (XML
   fallbacks); and the **ask/planning loop inside `streamTurn`** ([agent.ts:418-664](src/core/agent.ts#L418-L664)).
   Step spans and `delegate_to_agent` must reach each.
4. **Tool dispatch is duplicated & registry-less** — a `switch` ([generator-tools.ts:233-305](src/agent-mode/generator-tools.ts#L233-L305))
   and `dispatchXmlToolCall` ([action-executor.ts:29-79](src/core/helpers/action-executor.ts#L29-L79))
   with copy-pasted MCP routing. Adding a tool today means editing both + `AGENT_TOOLS` + the XML prompt.
5. **No provider surfaces token usage** ([model-provider.ts:49-55](src/providers/model-provider.ts#L49-L55)) → token attrs deferred.
6. **`rei.config.json` was removed** (commit `cdeb6a5`) but `loadReiConfig` + `ReiConfig` remain → extend, don't reinvent.
7. **Pure ESM, `strict:true`, no ESLint** → async-safety rules are manual discipline.
8. **The HTTP server already shares one mutable `Agent` + one on-disk session across all requests with
   no mutex** ([server.ts:46-48](src/server.ts#L46-L48)) — it *assumes* a serial client today. A2A
   serving must **not** inherit this by accident; it gets its own dedicated serving Agent (ADR 0001).
9. **Mode alone does not make a Worker read-only.** Even `ask`/`plan` mode executes `<execute_command>`
   ([agent.ts:578-605](src/core/agent.ts#L578-L605)), and `run_command` can mutate the workspace. So
   "read-only" cannot be claimed from mode selection — see §9.

---

## 4. Orchestration Model

### 4.1 Identity (self-declared, SRP) vs Role (emergent)
Two things v1–v4 conflated under "role":
- **Identity** — *what a Node is* (its single responsibility: "auditor", "librarian"). **Self-declared**
  in the AgentCard, **stable**. A Node knows its own Identity (the librarian knows it's a librarian).
- **Role** — *Orchestrator or Worker for this task*. **Emergent, per-task, never hardcoded.** A Node has
  a fixed Identity but a contextual Role; the same Node can orchestrate one task and be a worker for
  another, and a Worker may itself orchestrate sub-delegations.

So "role ≠ node" was really "*orchestration role* ≠ node" — it survives, while Identity is declared.

### 4.2 Topology: orchestrator–workers tree
Use **orchestrator–workers** (supervisor / agents-as-tools) — the depth-1 case of a hierarchical tree.
A2A is the transport only, and Nodes are implementation-agnostic, so a network may mix a **rei A2A Node**
with a **Claude A2A Node** or any other. Decentralized mesh/handoff is out of scope.

### 4.3 Synchronization = local joins only
**No global cross-node synchronization.** Each Orchestrator joins only its own direct children
(fan-in/scatter-gather; sequential data dependency; correlation by A2A task id; trace by `traceparent`).
Deep trees compose because each parent joins locally — never the whole tree.

### 4.4 Accept-but-serialize, synchronous (Phase 1)
A Node hosts **one dedicated serving Agent**, runs each task on a **fresh session**, **serializes** tasks
behind a mutex, and serves **synchronously** (Orchestrator awaits the bounded result). Requests may come
from **different Orchestrators**; they are accepted (not rejected) and processed one at a time. The
**`TaskExecutor` + task-id seam** keeps us open to Phase-2 concurrency (`N` workers, async ack, polling)
without touching the protocol layer. Full rationale and alternatives: [ADR 0001](../adr/0001-a2a-serving-concurrency.md).

### 4.5 Delegation safety: depth cap
Symmetric Nodes that can delegate risk **runaway depth** and **cycles**. Phase 1 propagates a
**delegation depth** (`a2a.depth`) in the A2A message metadata, alongside `traceparent`; a Node **refuses
to delegate past a max** (default 3) and returns *"delegation budget exhausted — answer directly"* as a
normal tool result (never an exception). Origin-based cycle detection is deferred.

### 4.6 2 → N nodes = config, not refactor
**Symmetry** (every Node serves + delegates) + **recursion** (a Worker can orchestrate) + **Nodes in
config** (`a2aNodes` map) means adding a third Node is one config line; the orchestration graph is
emergent at runtime, never enumerated in code.

---

## 5. Task lifecycle & A2A primitives

| Need | A2A answer | Note |
|---|---|---|
| **Ack** | `message/send` returns `Task{id, state}` | the id is the handle for everything after |
| **Heartbeat ("alive but busy")** | `message/stream` (SSE) `TaskStatusUpdateEvent`s; `tasks/get` | rei already SSE-keepalives every 10s ([server.ts:111-113](src/server.ts#L111-L113)) |
| **Long-running (hours)** | **push notifications** + `tasks/get` + `tasks/resubscribe` | standard async request-reply / LRO — Phase 2 |
| **Parent keeps control** | **deadline + `tasks/cancel`**; loop picks another path on timeout | every delegation is bounded (AbortController, cf. the 15s MCP timeout [http-client.ts:91-106](src/tools/mcp/http-client.ts#L91-L106)) |

⚠️ Push-notification support varies by SDK version — **verify the installed `@a2a-js/sdk` surface**.
Phase 1 needs only bounded-sync.

---

## 6. Capability Matrix — reference scenario

**Scenario:** Initiator **I** delegates to **A** (short), **B** (short), **C** (long-running);
I joins A+B → derives **D**; finally **combine(D, C)**.

### Phase 1 — bounded orchestration (in scope)
Everything that completes inside **one bounded reasoning Turn** (≤ MAX Steps):
sequential delegate + use result ✅; multiple delegations in one Step ✅ (serial today; parallel A‖B =
one-line `Promise.allSettled` change 🟡); bounded-sync delegation with deadline ✅; fan-in join A+B →
derive D ✅; unified cross-agent trace ✅. → **the entire A,B→D half is Phase 1.**

### Phase 2 — durable async (needs a subsystem)
The C / deferred-join half: **non-blocking delegation** (fire C, get task id, don't await);
**partial join** (proceed on A+B while C pends, poll via `check_delegation(id)`); **deferred join /
resume hours later** (durable, resumable orchestration state + resume entry point). Known art: durable
execution (Temporal / Inngest / Restate) or a homegrown task table.

### The delegate contract = the OCP boundary
- `delegate_to_agent(node, prompt)` → **bounded-sync**. Build now. Powers A, B, D.
- `delegate_async(node, prompt)` + `check_delegation(id)` → define the seam now, back it with the durable
  store later. Powers C. Both ride the **same `TaskExecutor` + task id**, so Phase 2 never rewrites Phase 1.

---

## 7. Integration Points — architectural & extensibility

- **IP-1 Telemetry bootstrap** — `src/telemetry/init.ts`, imported first by `main.ts`/`server.ts`.
  Manual spans only in v1 (ESM blocks cheap auto-HTTP instrumentation). Owns SDK lifecycle +
  `shutdownTelemetry()`. Uses **`SimpleSpanProcessor`** (decision §2).
- **IP-2 Root span (Turn)** — wrap `Agent.runTurn`/`streamTurn` ([agent.ts:135](src/core/agent.ts#L135), [:177](src/core/agent.ts#L177)).
  Both CLI and server funnel here. **One user prompt = one `rei.turn` root span.** Attrs: `rei.mode`,
  `rei.provider`, `rei.correlation_id`, `rei.workspace`.
- **IP-3 Step spans** — one `withStepSpan(n, attrs, fn)` helper at each of the three loop heads.
  Child span **`step-N`**; attrs `step.number`, `step.finish_reason`, `step.tool_calls`.
- **IP-4 LLM-call span** — wrap the `ModelProvider` **once** in `provider-factory` with
  `withTelemetry(provider)` (all providers + the future token-usage seam).
- **IP-5 Tool span + `delegate_to_agent`** — extract one `dispatchBuiltinTool(name, args, ctx)` in
  `src/agent-mode/tool-dispatch.ts` shared by both dispatch paths (de-dupes MCP routing, hosts the
  delegate tool + tool spans). The delegate tool's description **lists the configured `a2aNodes` labels**
  so the model knows whom it can delegate to.
- **IP-6 A2A serving** — `startA2AServer({ workspacePath, port }): { close() }`, started from `server.ts`
  and `run-chat.ts`/`run-cli.ts` finally. **One dedicated serving Agent + fresh session per task + mutex**
  (ADR 0001). Own `A2A_PORT` via the SDK's Express app (don't graft onto `/chat/completions`). AgentCard
  declares the Node's **Identity** (name/skills); Phase-1 skill is a generic `run_task` (text prompt in).
- **IP-7 A2A client + delegation** — `src/a2a/client.ts` (`sendTask`), bounded by AbortController, reads
  the URL from `ReiConfig.a2aNodes`, **increments `a2a.depth`** and enforces the cap (§4.5). Depends on a
  narrow `RunTask` contract, not Agent internals.
- **IP-8 Config** — `ReiConfig.a2aNodes?: Record<string,string>` + `getA2ANodes()`, reuse `loadReiConfig`.
- **IP-9 Context propagation** — `src/telemetry/a2a-propagation.ts` inject/extract over `Message.metadata`
  (carries `traceparent` **and** `a2a.depth`). **Load-bearing:** metadata must survive into the executor's
  `RequestContext` — spike first.

**Extensibility scorecard:** LLM spans → `withTelemetry(provider)`; new tools → `dispatchBuiltinTool()`;
Step spans → `withStepSpan()`; serving + concurrency → `startA2AServer()` + `TaskExecutor` queue;
delegation sync→async → `delegate_to_agent` + `delegate_async` on one `TaskExecutor`; 2→N nodes →
symmetry + recursion + `a2aNodes` config.

---

## 8. Implementation Phases

**Phase 0 — Doc & glossary:** this file + [CONTEXT.md](../../CONTEXT.md) + [ADR 0001](../adr/0001-a2a-serving-concurrency.md).

**Iteration 1 — OTel + Laminar.** `telemetry/init.ts` (+`shutdownTelemetry`, `SimpleSpanProcessor`),
`telemetry/spans.ts` (`withStepSpan`), `withTelemetry(provider)`. Root span on `runTurn`/`streamTurn`,
Step spans on the three loops. Flush on `SIGINT`/`beforeExit`. Gate exporters off under test
(`OTEL_SDK_DISABLED`). Verify: `rei chat` → Laminar shows `rei.turn` + `step-N`.

**Iteration 2 — A2A serving.** `a2a/server.ts` (`startA2AServer`, AgentCard with Identity, `run_task`,
`AgentExecutor`, **one dedicated serving Agent + mutex + fresh session per task**), `a2a/types.ts`
(`RunTask`, `TaskExecutor`). Wire into `server.ts` + `run-chat.ts`. Install `@a2a-js/sdk` (+`express`).
Verify with a real A2A client.

**Iteration 3 — Delegation (bounded-sync).** `a2a/client.ts`, `agent-mode/tool-dispatch.ts` (unified),
`DELEGATE_TO_AGENT_TOOL` (description lists `a2aNodes`). `ReiConfig.a2aNodes`. Depth cap in the client.
Verify Planner→Auditor; two traces.

**Iteration 4 — Cross-agent trace.** `telemetry/a2a-propagation.ts`; inject `traceparent`+`a2a.depth` into
`message.metadata`, extract on serve → root span as child. **Pre-req: IP-9 spike green.** Verify: one trace.

**Iteration 5 — Demo polish + security note.** Tool/`a2a.*` attrs; `docs/demo/planner-auditor.md`; the
documented security gap (§9). Token attrs stay deferred.

**Phase 2 (future):** capability profiles (read-only enforcement); `delegate_async`/`check_delegation`,
durable pending-task store, push-notification + resume, `tasks/cancel`; concurrent serving (`N` workers,
async ack); origin-based cycle detection.

---

## 9. Security Posture (explicit)

**Phase 1 accepts a known, documented gap:** a served task runs on the Node's full-capability Agent —
it can `edit_file`, `create_file`, and `run_command`. **Mode selection does not constrain this** (even
`ask` mode runs commands, §3.9). The "read-only Auditor" is therefore a **convention** (the task prompt
is analytical), **not an enforced guarantee**. An Orchestrator must treat a Worker as trusted today; do
not expose A2A serving to untrusted Nodes in Phase 1.

**Phase 2 closes it** with a **capability profile** per Node: the served Agent runs with a restricted
tool set (e.g. no `edit_file`/`create_file`/`run_command`), and the Node's AgentCard *declares* its
profile so Orchestrators know what they're getting before delegating. The depth cap (§4.5) is the Phase-1
guard against runaway delegation; SRP keeps each Node's responsibility (and thus its needed capabilities)
narrow.

---

## 10. Unsolved Points / Warnings

1. **A2A `metadata` pass-through is load-bearing & unverified** — the unified trace *and* the depth cap
   ride `Message.metadata` into the executor's `RequestContext`. **Spike before iter 4.**
2. **`Agent` is not concurrency-safe** — mitigated by ADR 0001 (dedicated serving Agent + mutex). True
   parallel serving needs a turn-stateless `Agent` (Phase-2 debt).
3. **Spans on `process.exit`** — `SimpleSpanProcessor` chosen to avoid loss; still flush on `SIGINT`.
4. **A2A SDK shape** — verify the installed `@a2a-js/sdk` surface (AgentCard/AgentExecutor/`message/send`);
   v2's `sendTask({skill,input})`/`POST /tasks` is fictional.
5. **Laminar ports/version unverified** — pin image + confirm compose ports (postgres + clickhouse).
6. **ESM blocks OTel HTTP auto-instrumentation** — manual spans only.
7. **Tests hit the exporter** — gate with `OTEL_SDK_DISABLED=true` under Vitest.
8. **Edit-format coverage** — `delegate_to_agent` must work on the demo provider's path; do the unified
   dispatcher (IP-5).
9. **MCP context budget** — keep new tool schemas lean ([agent.ts:863-870](src/core/agent.ts#L863-L870)).
10. **Security gap is deliberate** (§9) — Phase 1 serving is unconstrained; do not deploy to untrusted peers.
11. **Long-running orchestration is Phase 2** — Phase 1 cannot do the C / deferred-join half (§6).

---

## 11. Critical Files

| File | Action |
|---|---|
| `CONTEXT.md`, `docs/adr/0001-a2a-serving-concurrency.md` | Create — glossary + serving-concurrency ADR |
| `src/telemetry/init.ts`, `spans.ts`, `a2a-propagation.ts` | Create — SDK bootstrap, `withStepSpan`, inject/extract |
| `src/providers/provider-factory.ts` | Modify — `withTelemetry(provider)` (IP-4) |
| `src/core/agent.ts` | Modify — root (Turn) span + Step spans |
| `src/agent-mode/generator-tools.ts`, `generator.ts` | Modify — Step spans; route via unified dispatcher |
| `src/agent-mode/tool-dispatch.ts` | Create — unified dispatcher + tool spans (IP-5) |
| `src/core/helpers/action-executor.ts` | Modify — XML path calls unified dispatcher |
| `src/contracts/tool-definitions.ts` | Modify — `DELEGATE_TO_AGENT_TOOL` |
| `src/a2a/server.ts`, `client.ts`, `types.ts` | Create — serve/delegate, `RunTask`, `TaskExecutor`, depth cap |
| `src/server.ts`, `src/cli/run-chat.ts`, `run-cli.ts` | Modify — start/close A2A serving |
| `src/tools/mcp/mcp-config.ts` | Modify — `ReiConfig.a2aNodes` + `getA2ANodes()` |
| `src/main.ts` | Modify — first-import telemetry |
| `rei.config-example.json`, `.env.example`, `docker-compose.yml` | Modify/Create — `a2aNodes`, `OTEL_*`, `A2A_PORT`, Laminar |
| `docs/demo/planner-auditor.md` | Create — runbook |

---

## 12. Verification (final demo)

1. `docker compose up -d` → Laminar reachable.
2. Terminal A: `A2A_PORT=7778 rei server` (Auditor Node; AgentCard Identity "auditor").
3. Terminal B: `rei chat` with `rei.config.json` `a2aNodes.auditor = http://localhost:7778`, prompt:
   *"Add a caching layer to the providers. Before planning, ask the auditor to check if any caching already exists."*
4. Laminar: **one** trace — Planner `rei.turn` → `step-N` → `tool.delegate_to_agent` → Auditor `rei.turn`
   (child) → Auditor `step-M` → `llm-call`. `traceparent` + `a2a.depth` visible on the A2A message.
5. `npm run check` and `npm test` green (telemetry gated off under test).

---

## 13. Change History

| Version | Date | What changed & why |
|---|---|---|
| **v1** | 2026-06-12 | **Standalone MVP.** Separate `packages/` (generic Library + Claude Task agents), not integrated into rei. Goal: prove W3C `traceparent` propagates across two A2A agents into one Laminar trace. Established the thesis: *build on giants; the only novel code is A2A context propagation.* |
| **v2** | 2026-06-12 | **First rei-integrated plan** (5 iterations / 10 days). Introduced the Planner/Auditor demo, `A2A_PORT` sidecar, `rei.config.json` `agents` map, root + per-turn spans. Contained several assumptions later found wrong (one-shot `rei "prompt"`, single agent loop, fictional A2A SDK shape). |
| **v3** | 2026-06-12 | **Reality-check + Integration Points.** Verified v2 against the code and corrected it (no one-shot CLI; three execution paths; duplicated registry-less tool dispatch; no token usage; ESM/config-removed). Added IP-1…IP-9, an extensibility scorecard, and an explicit unsolved-points list. Locked: server-primary + CLI-lifecycle host; token attrs deferred; peers via `ReiConfig`. |
| **v4** | 2026-06-13 | **Orchestration model.** role≠node; orchestrator–workers tree; **local-joins-only** synchronization; the **accept/ack vs execute** OCP seam; A2A task lifecycle (ack / heartbeat / long-running / cancel); the **capability matrix** (Phase 1 bounded vs Phase 2 durable) via the A/B/C/D scenario; `delegate_to_agent` vs `delegate_async` as the OCP boundary. |
| **v5** | 2026-06-13 | **Grilled & hardened.** Established the [CONTEXT.md](../../CONTEXT.md) glossary and resolved overloaded language: **Turn vs Step** (and span names `rei.turn`/`step-N`); **A2A Node** made implementation-agnostic (Claude/other Nodes allowed); **Identity (self-declared, SRP) vs Role (emergent)**. New decisions: serving = **one dedicated serving Agent + fresh session per task + mutex (serial, synchronous)** → [ADR 0001](../adr/0001-a2a-serving-concurrency.md); worker safety = **convention + documented security gap now, capability profile in Phase 2** (§9); **propagated delegation-depth cap** in Phase 1 (origin cycle detection deferred); `SimpleSpanProcessor`; config renamed `a2aPeers` → **`a2aNodes`**. |
