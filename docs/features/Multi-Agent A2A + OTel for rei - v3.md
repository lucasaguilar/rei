# Plan (v3, extended): Multi-Agent A2A + OTel for rei

> Supersedes the detail in `docs/features/Plan: Multi-Agent A2A + OTel for rei (v2).md`.
> Keeps the v2 goals and iteration shape, but corrects them against what the code
> actually does, adds an **Integration Points** architectural analysis, and ends with
> an explicit **Unsolved Points / Warnings** section.

---

## Context

rei is a personal AI-agent CLI + HTTP server (TypeScript, pure ESM). We want two
capabilities, delivered in vertical slices:

1. **OpenTelemetry** — every rei *turn* emits a trace (root span + per-iteration child
   spans + tool spans) to a self-hosted Laminar backend.
2. **A2A** — rei can both **serve** tasks to peer agents and **delegate** tasks to peers,
   with the trace context propagating across the boundary so Laminar shows **one unified
   trace** (Planner's turn → Auditor's turns as children).

**Decisions locked in with the user:**

| Question | Decision |
|---|---|
| A2A host | **Primary: `src/server.ts`** (long-running). **Also: the CLI serves A2A during its REPL lifecycle.** → A2A server is a *startable/stoppable component* invoked from both entry points, on its own `A2A_PORT`. |
| Token/LLM-token span attrs | **Deferred.** v1 instruments root + turn + tool/delegate spans from data already available. A `usage` field on the provider interface is a separate follow-up; the provider-tracing decorator (below) is the seam that makes it a one-file change later. |
| Peer-agent discovery config | **Extend the existing `ReiConfig`** (`rei.config.json` → `a2aPeers` map), reuse `loadReiConfig`. Consistent with how MCP servers are already configured. |

---

## What the v2 plan got wrong (verified against the code)

These are corrections, not opinions — each is backed by a file:line.

1. **There is no one-shot `rei "prompt"` mode.** `runCli` ([src/cli/run-cli.ts:8-68](src/cli/run-cli.ts#L8-L68))
   only accepts `plan "<task>"` (one-shot) or `chat` (interactive REPL via `runChat`). Every
   v2 verification line like `rei "list all TypeScript files in src/"` would just print
   *"Unknown command"*. **All demo/verification commands must be rewritten** to `rei chat`,
   `rei plan "..."`, or `rei server`.

2. **The CLI is short-lived.** `runCli` runs one command and returns; the only long-running
   surface is the interactive `chat` REPL and `src/server.ts`. An A2A *server* can therefore
   only live (a) for the duration of a `chat` REPL, or (b) inside `rei server`. This is why
   the A2A server is modeled as a component started from both, not a magic `A2A_PORT rei`.

3. **There are three agent execution paths, not one** — all selected inside
   [src/core/agent.ts](src/core/agent.ts):
   - `executeAgentTurnWithTools` — structured function-calling, used **when the active
     agent provider implements `completeChatWithTools`** ([generator-tools.ts:94-365](src/agent-mode/generator-tools.ts#L94-L365)).
   - `executeAgentTurnWholefile` / `executeAgentTurn` — XML fallbacks ([generator.ts](src/agent-mode/generator.ts)).
   - The **ask/planning streaming loop** inside `Agent.streamTurn` itself
     ([agent.ts:418-664](src/core/agent.ts#L418-L664)) — a *separate* `while` loop that is
     not in the generators at all.

   v2 only mentions `generator.ts`. Any "per-turn span" must be added at **each** loop, and
   `delegate_to_agent` must be reachable from **each** dispatch path.

4. **Tool dispatch is duplicated, hardcoded, and registry-less.** Structured tools are a
   `switch (call.function.name)` ([generator-tools.ts:233-305](src/agent-mode/generator-tools.ts#L233-L305));
   XML tools go through `dispatchXmlToolCall` ([action-executor.ts:29-79](src/core/helpers/action-executor.ts#L29-L79)).
   MCP routing logic is *copy-pasted* between the two. There is **no built-in-tool registry**;
   adding a tool today means editing both dispatchers **plus** `AGENT_TOOLS`
   ([contracts/tool-definitions.ts:132-137](src/contracts/tool-definitions.ts#L132-L137)) **plus**
   advertising it in the XML system prompt. This is the central extensibility problem (addressed below).

5. **No provider surfaces token usage.** `ChatCompletionWithTools`
   ([model-provider.ts:49-55](src/providers/model-provider.ts#L49-L55)) returns
   `content / toolCalls / finishReason / reasoning` — no usage. `completeChat` returns a bare
   string. So v2 iteration-5's `llm.input_tokens`/`output_tokens` are **not available** without
   changing the interface across all 6 providers. → **deferred** (per decision above).

6. **`rei.config.json` was removed** (commit `cdeb6a5`) but `loadReiConfig` + the `ReiConfig`
   type still exist and read `mcpServers`, falling back to `{}`. So re-introducing the file with
   an `a2aPeers` key and reusing the loader is the consistent path (no new config mechanism).

7. **Pure ESM** (`"type": "module"`, `NodeNext`, tsc → `dist/`, run via
   `bin/rei.js → import "../dist/main.js"`). This changes how OTel must boot (see Integration Point 1).

---

## Integration Points — Architectural Analysis & Extensibility

This is the heart of the review: **where** each capability attaches, **why** there, and the
**extensible** shape vs the quick hack.

### IP-1 — Telemetry bootstrap (entry seam)
- **Where:** new `src/telemetry/init.ts`; imported **first** by `src/main.ts` and `src/server.ts`.
- **ESM reality:** for *manual* spans, a top-of-file `import "./telemetry/init.js"` is enough
  (ESM evaluates the imported module graph before the importing module body). For **auto-
  instrumentation** of outbound HTTP (to capture LLM/MCP calls automatically), Node ESM needs the
  instrumentation registered via a loader/`--import` hook **before** any instrumented module loads —
  a plain import is too late. → **Recommendation:** do **not** rely on auto-instrumentation for v1.
  Use manual spans (provider decorator, IP-4). If auto-HTTP is wanted later, change
  `bin/rei.js` to `import "../dist/telemetry/init.js"` *before* `import "../dist/main.js"`, or set
  `NODE_OPTIONS=--import ...`.
- **Extensibility:** `init.ts` reads `OTEL_*` env, exposes a single `tracer` + a `shutdownTelemetry()`.
  One module owns SDK lifecycle; nothing else imports `@opentelemetry/sdk-node`.

### IP-2 — Root span (the "one invocation = one trace" seam)
- **Where:** `Agent.runTurn` ([agent.ts:135](src/core/agent.ts#L135)) and `Agent.streamTurn`
  ([agent.ts:177](src/core/agent.ts#L177)). **Both** CLI and server reach the model only through
  these two methods → instrument once here and every surface is covered.
- **Semantics correction:** "one rei invocation = one root span" is wrong for the REPL (one process,
  many prompts). The correct unit is **one user prompt = one root span** = one `runTurn`/`streamTurn`
  call. Root attributes available *today*: `rei.mode` (`session.mode`), `rei.provider`,
  `rei.correlation_id` (`this.correlationId`), `rei.workspace`.

### IP-3 — Turn (iteration) spans
- **Where:** the three loops — `generator-tools.ts:94`, the `executeAgentTurn(Wholefile)` loops in
  `generator.ts`, and the ask/planning loop at `agent.ts:418`. Each `loopCount++/depth++` is one turn.
- **Extensibility:** add one helper `withTurnSpan(n, attrs, fn)` in `src/telemetry/spans.ts` and call it
  at each loop head, rather than hand-rolling `startActiveSpan` three times. Attributes:
  `turn.number`, `turn.finish_reason`, `turn.tool_calls`.

### IP-4 — LLM-call span (instrument the provider, not 6 providers)
- **Where (recommended):** wrap the `ModelProvider` **once** in `createModelProvider` /
  `createProviderForMode` ([provider-factory.ts](src/providers/provider-factory.ts)) with a
  **tracing decorator** `withTelemetry(provider)` that wraps `completeChat`, `streamChat`,
  `completeChatWithTools` in an `llm-call` span. This is strictly better than editing each provider:
  it is one file, applies uniformly, and is the **single future seam for token usage** (when a
  `usage` field is added, the decorator reads it → no other change).
- **Anti-pattern to avoid:** instrumenting at the call sites (generator-tools.ts:115,
  token-streamer.ts) — there are several and they'd drift.

### IP-5 — Tool span + the `delegate_to_agent` tool (unify the dispatchers)
- **Problem:** two dispatchers, duplicated MCP routing, no registry (point 4 above).
- **Recommended extensible shape:** extract a single `dispatchBuiltinTool(name, args, ctx)` in
  `src/agent-mode/tool-dispatch.ts` that owns: the built-in tools, the `mcp:` routing (de-duplicating
  the copy-paste), **and** the new `delegate_to_agent`, each wrapped in a `tool.<name>` span. Both the
  structured `switch` default and `dispatchXmlToolCall` then call this one function. Net effect: adding
  a tool becomes "add a `ToolDefinition` + one handler", and MCP routing stops being duplicated.
- **Minimal-change fallback (if you don't want the refactor in this PR):** add a `DELEGATE_TO_AGENT_TOOL`
  to `AGENT_TOOLS`, a `case "delegate_to_agent"` in [generator-tools.ts:233-305](src/agent-mode/generator-tools.ts#L233-L305),
  a branch in [action-executor.ts:29-79](src/core/helpers/action-executor.ts#L29-L79), and a line in the
  XML system-prompt advertisement (`formatMcpToolsForPrompt`-adjacent). Document the duplication as debt.
  **Recommendation: do the unify; it pays for itself the first time a third tool is added.**

### IP-6 — A2A server (startable component, two hosts)
- **Where:** new `src/a2a/server.ts` exporting `startA2AServer({ workspacePath, port }): { close() }`.
  Started from:
  - `src/server.ts` — after `agent.connectMcp()` ([server.ts:53](src/server.ts#L53)), if `A2A_PORT` set.
  - `src/cli/run-chat.ts` — at REPL start; `close()` in the `finally` of
    [run-cli.ts:65-67](src/cli/run-cli.ts#L65-L67) so it dies with the REPL.
- **Critical isolation requirement:** the A2A handler **must not** reuse the interactive `Agent`/session.
  `Agent` carries per-turn mutable state — `correlationId`, `pendingHardwareWarnings`, the per-turn
  `logger` ([agent.ts:104-118](src/core/agent.ts#L104-L118)) — and `prepareSessionForTurn` mutates the
  passed `session`. A concurrent A2A task + user turn would interleave/clobber. → **The A2A server owns a
  dedicated `Agent` and creates a fresh `ChatSession` per task, and serializes tasks behind a mutex**
  (see Unsolved #2 for why serialize). The handler maps an incoming task to one `agent.runTurn(freshSession, prompt)`.
- **Transport reality:** `src/server.ts` is raw `node:http`; `@a2a-js/sdk` ships an **Express**
  integration (`A2AExpressApp`). → run the A2A listener on its **own port** (`A2A_PORT`) via the SDK's
  Express app; do **not** try to graft A2A onto the raw `/chat/completions` server. "Reuse server.ts"
  means "start the A2A component from inside the server process," not "share the HTTP router".

### IP-7 — A2A client + delegation
- **Where:** new `src/a2a/client.ts` (`sendTask(agentName, prompt): Promise<string>`), reading the
  peer URL from `ReiConfig.a2aPeers`. Invoked by the `delegate_to_agent` handler from IP-5.

### IP-8 — Config seam
- **Where:** extend `ReiConfig` ([tools/mcp/mcp-config.ts](src/tools/mcp/mcp-config.ts)) with
  `a2aPeers?: Record<string,string>`; add a tiny `getA2APeers(workspacePath)` reusing `loadReiConfig`.
  Add `a2aPeers` to `rei.config-example.json`.

### IP-9 — Cross-agent context propagation (the only genuinely novel code)
- **Where:** `src/telemetry/a2a-propagation.ts` — `injectContext(carrier)` (client) /
  `extractContext(carrier)` (server), pure `@opentelemetry/api`.
- **Load-bearing assumption:** A2A `Message.metadata` survives the round trip and arrives intact in the
  server executor's `RequestContext`. The whole unified-trace story rests on this. → **Spike it before
  iteration 4** (Unsolved #1).

### Extensibility scorecard (recommended seams)
| Concern | Quick hack | Extensible seam (recommended) |
|---|---|---|
| LLM spans / future token usage | edit 6 providers | **`withTelemetry(provider)` decorator in provider-factory** |
| New tools (delegate + later) | edit 2 dispatchers + prompt | **`dispatchBuiltinTool()` shared by both paths** |
| Turn spans | 3× inline `startActiveSpan` | **`withTurnSpan()` helper** |
| A2A serving | per-process glue | **`startA2AServer()` component, dedicated Agent** |
| A2A skills ↔ rei tools | hand-written AgentCard | **generate AgentCard skills from `ToolDefinition` metadata** (future) |

---

## Iterations (corrected)

### Iteration 1 — OTel foundation + Laminar (Days 1-2)
**Create:** `docker-compose.yml` (Laminar self-hosted; **verify actual ports** — Unsolved #4),
`src/telemetry/init.ts` (NodeSDK + OTLP-HTTP exporter + W3C propagator + `shutdownTelemetry()`),
`src/telemetry/spans.ts` (`withTurnSpan`), `.env.example` additions (`OTEL_*`, `A2A_PORT`),
`withTelemetry(provider)` decorator wired into `provider-factory`.
**Modify:** `src/main.ts` + `src/server.ts` first-import telemetry; `Agent.runTurn`/`streamTurn` open
the **root span** (IP-2); the three loops open **turn spans** (IP-3); register `shutdownTelemetry()` on
`SIGINT`/`SIGTERM`/`beforeExit` and before deliberate `process.exit` calls (Unsolved #3).
**Install:** `@opentelemetry/{sdk-node,api,exporter-trace-otlp-http,resources,semantic-conventions}`.
**Verify:** `docker compose up -d`; `rei chat` → run a prompt → Laminar shows a `rei.turn` root with
`turn-N` children. Guard tests with `OTEL_SDK_DISABLED=true` (Unsolved #5).

### Iteration 2 — A2A server (Days 3-4)
**Create:** `src/a2a/server.ts` (`startA2AServer`, AgentCard with skill `run_task`, `AgentExecutor`
mapping message-text→prompt, dedicated isolated `Agent`, task mutex), `src/a2a/types.ts`.
**Modify:** `src/server.ts` (start if `A2A_PORT`), `src/cli/run-chat.ts` + `run-cli.ts` finally (start/close).
**Install:** `@a2a-js/sdk` (+ `express` for `A2AExpressApp`).
**Verify:** `A2A_PORT=7778 rei server`; send an A2A `message/send` with a prompt; rei runs it and returns
a result; Laminar shows a new root trace for the A2A-triggered run. **(Use the real SDK client to send —
not the v2 `curl /tasks` shape, which is not the A2A protocol.)**

### Iteration 3 — A2A client + delegation (Days 5-6)
**Create:** `src/a2a/client.ts` (`sendTask`), `src/agent-mode/tool-dispatch.ts` (unified dispatcher, IP-5),
`DELEGATE_TO_AGENT_TOOL` in `contracts/tool-definitions.ts`.
**Modify:** `ReiConfig` + `rei.config-example.json` (`a2aPeers`); both dispatch paths call
`dispatchBuiltinTool`; XML system-prompt advertises `delegate_to_agent`.
**Verify:** Terminal A `A2A_PORT=7778 rei server` (Auditor); Terminal B
`rei chat` → *"Ask the auditor agent to list all providers in the codebase"* → Planner calls
`delegate_to_agent`, Auditor responds. Laminar: **two** separate traces (linking is iteration 4).

### Iteration 4 — Cross-agent trace propagation (Days 7-8)
**Create:** `src/telemetry/a2a-propagation.ts`.
**Modify:** `client.ts` injects `traceparent` into `message.metadata`; `server.ts` extracts from
`requestContext.userMessage.metadata` and starts its root span as a child of the extracted context.
**Verify:** re-run iteration 3 → **one** Laminar trace; Planner's turn span contains Auditor's turns.
**Pre-req:** Unsolved #1 spike confirmed.

### Iteration 5 — Demo polish (Days 9-10)
Tool spans already present (IP-5). Add `a2a.target_agent` / `a2a.skill` attrs. Write
`docs/demo/planner-auditor.md` runbook (corrected commands). Update `docs/features/multi-agent.md`.
**Token attrs remain deferred** — note the `withTelemetry` seam where they'd land.

---

## ⚠️ Unsolved Points / Warnings (read before starting)

1. **A2A `metadata` pass-through is unverified and load-bearing.** The entire unified-trace result
   depends on `@a2a-js/sdk` preserving `Message.metadata` end-to-end into the server executor's
   `RequestContext`. **Spike this first** against the *installed* SDK version. If it drops metadata,
   the W3C-traceparent approach fails and you need a fallback carrier (custom A2A extension, or an HTTP
   header on the JSON-RPC call). Do not schedule iteration 4 until this is green.

2. **`Agent` is not concurrency-safe.** Per-turn mutable instance state (`correlationId`,
   `pendingHardwareWarnings`, per-turn `logger`) and in-place `session` mutation mean two overlapping
   turns corrupt each other. When the **CLI** serves A2A *while* the user is mid-prompt, that overlap is
   real. v1 mitigation: dedicated A2A `Agent` + **serialize tasks behind a mutex** + fresh session per
   task. True parallel multi-agent serving needs refactoring `Agent` to be turn-stateless — out of scope,
   flag as debt.

3. **Spans will be lost on `process.exit`.** The codebase calls `process.exit(1)` in many paths
   ([run-cli.ts](src/cli/run-cli.ts) and others). With a BatchSpanProcessor, buffered spans never flush.
   Either use `SimpleSpanProcessor` for the demo (immediate export) or call
   `await shutdownTelemetry()` before every deliberate exit and on `SIGINT`. Easy to forget → decide now.

4. **The A2A SDK shape in v2 is fictional.** `sendTask({skill, input, metadata})` / `POST /tasks` is **not**
   the A2A protocol. Real `@a2a-js/sdk` v0.3: server = `AgentCard` + `AgentExecutor` + `DefaultRequestHandler`
   + `A2AExpressApp`; client = `A2AClient.sendMessage({ message:{ role, parts, messageId, metadata } })`;
   transport = JSON-RPC `message/send` / `message/stream` + `/.well-known/agent-card.json`. **All A2A
   pseudocode in v2 must be rewritten** against the real API; verify the exact version's surface before coding.

5. **Laminar Docker ports/version unverified.** v2 asserts "OTLP HTTP + UI both on 8080". Laminar typically
   splits UI and OTLP ingest across ports and needs `postgres` + `clickhouse`. **Pin the Laminar image
   version and confirm its compose/ports** from upstream before writing `docker-compose.yml`.

6. **ESM blocks OTel HTTP auto-instrumentation.** Manual spans are fine; auto-capturing outbound LLM/MCP
   HTTP needs `--import`/loader-hook registration before module load (IP-1). v1 deliberately uses manual
   spans (provider decorator) — don't promise auto-instrumentation you can't get cheaply in ESM.

7. **Tests will hit the exporter.** Importing instrumented modules under Vitest will try to export spans
   (connection errors / slow tests). Gate with `OTEL_SDK_DISABLED=true` (or a no-op exporter) when
   `VITEST`/`NODE_ENV=test`. Add before iteration 1 lands.

8. **Edit-format coverage.** `delegate_to_agent` must work in whichever path the chosen demo provider
   uses. If the demo runs a `completeChatWithTools` provider, the structured `switch` is enough for the
   happy path — but the XML branch and ask/planning loop will silently lack the tool unless IP-5's unified
   dispatcher is done. Confirm the demo provider's path, or do the unify, to avoid a "works on my model"
   surprise.

9. **MCP cost interaction.** The agent already warns when MCP tool schemas eat >40% of the context window
   ([agent.ts:863-870](src/core/agent.ts#L863-L870)). Adding `delegate_to_agent` (and any future A2A-as-tools
   exposure) adds to that budget — keep the new tool schema lean.

---

## Critical Files Summary

| File | Action |
|---|---|
| `src/telemetry/init.ts` | Create — SDK bootstrap + `shutdownTelemetry()` |
| `src/telemetry/spans.ts` | Create — `withTurnSpan` helper |
| `src/telemetry/a2a-propagation.ts` | Create — inject/extract W3C context |
| `src/providers/provider-factory.ts` | Modify — wrap provider in `withTelemetry()` (IP-4) |
| `src/core/agent.ts` | Modify — root span in `runTurn`/`streamTurn`; turn spans in loops |
| `src/agent-mode/generator-tools.ts`, `generator.ts` | Modify — turn spans; route tools via unified dispatcher |
| `src/agent-mode/tool-dispatch.ts` | Create — unified built-in tool dispatcher + tool spans (IP-5) |
| `src/core/helpers/action-executor.ts` | Modify — XML path calls unified dispatcher |
| `src/contracts/tool-definitions.ts` | Modify — add `DELEGATE_TO_AGENT_TOOL` |
| `src/a2a/server.ts`, `client.ts`, `types.ts` | Create — A2A serve/delegate (real SDK API) |
| `src/server.ts`, `src/cli/run-chat.ts`, `src/cli/run-cli.ts` | Modify — start/close A2A component |
| `src/tools/mcp/mcp-config.ts` | Modify — `ReiConfig.a2aPeers` + `getA2APeers()` |
| `src/main.ts` | Modify — first-import telemetry |
| `bin/rei.js` | Modify (only if auto-instrumentation wanted) — import telemetry before main |
| `rei.config-example.json`, `.env.example` | Modify — `a2aPeers`, `OTEL_*`, `A2A_PORT` |
| `docker-compose.yml` | Create — Laminar (pin version, verify ports) |
| `docs/demo/planner-auditor.md`, `docs/features/multi-agent.md` | Create/Update — corrected runbook |

## End-to-end verification (final demo)
1. `docker compose up -d` → Laminar reachable.
2. Terminal A: `A2A_PORT=7778 rei server` (Auditor; `a2aPeers` not needed here).
3. Terminal B: `rei chat` with `rei.config.json` `a2aPeers.auditor = http://localhost:7778`, then prompt:
   *"I want to add a caching layer to the providers. Before planning, ask the auditor agent to check if any caching already exists."*
4. Laminar: **one** trace — Planner root → `turn-N` → `tool.delegate_to_agent` → Auditor root (as child)
   → Auditor `turn-M` → `llm-call` spans. `traceparent` visible on the A2A message.
5. `npm run check` and `npm test` green (telemetry gated off under test).
