# Plan: Multi-Agent A2A + OTel for rei (v2)

## Context

rei is a personal AI agent CLI (TypeScript, `src/main.ts`) and HTTP server (`src/server.ts`).
This plan adds two capabilities in vertical slices over 10 days:

1. **OpenTelemetry** — rei emits traces (root span + per-turn child spans) to a self-hosted Laminar backend
2. **A2A** — rei can both *serve* tasks to peer agents and *delegate* tasks to peer agents

**Demo scenario (end state):** User opens rei CLI and prompts: *"Plan the next feature. Before you start, ask the auditor agent to summarize the current architecture."*
- Planner rei decides what to do; Auditor rei (second instance, same repo) analyzes what exists
- Laminar shows **one unified trace**: Planner's turns contain Auditor's turns as child spans

---

## Architecture Decisions (from grill)

| Decision | Resolution |
|---|---|
| A2A role | Both server AND client |
| A2A server skill | `run_task` |
| A2A sidecar activation | `A2A_PORT` env var; works on both CLI and server entry points |
| Agent discovery | Static config in `rei.config.json` (→ dynamic Agent Cards later) |
| Trace unit | One rei invocation = one root span |
| Initial span depth | Root + per-turn spans (expand to LLM-call spans in iteration 5) |
| OTel init location | `src/telemetry/init.ts` — imported first by both `main.ts` and `server.ts` |
| Demo agents | Two rei instances (Planner + Auditor), same repo, different configs |

---

## Iterations

### Iteration 1 — Days 1–2: OTel foundation + Laminar running

**Goal:** rei CLI emits a real trace to Laminar on every invocation.

**Files to create:**
- `docker-compose.yml` — self-hosted Laminar stack (`postgres`, `clickhouse`, `laminar` service); Laminar OTLP HTTP on port 8080
- `src/telemetry/init.ts` — calls `NodeSDK.start()`, configures `OTLPTraceExporter` pointing at `OTEL_EXPORTER_OTLP_ENDPOINT`, registers W3C propagator
- `.env.example` — `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `A2A_PORT`

**Files to modify:**
- `src/main.ts` — add `import './telemetry/init.js'` as first import
- `src/server.ts` — same first import
- `src/agent-mode/generator.ts` — wrap each turn iteration in a child span (`tracer.startActiveSpan('turn-N', ...)`); set root span attributes: `rei.mode`, `rei.provider`, `rei.max_turns`

**Install:**
```
npm install @opentelemetry/sdk-node @opentelemetry/api @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

**Verification:**
1. `docker compose up -d` → Laminar UI at `http://localhost:8080`
2. `rei "list all TypeScript files in src/"` (agent mode)
3. Open Laminar → Traces → see one trace named `rei-invocation` with N child `turn-1`, `turn-2`… spans

---

### Iteration 2 — Days 3–4: A2A server — rei accepts tasks from peers

**Goal:** rei exposes an A2A endpoint; any peer can send it a task and get a result.

**Files to create:**
- `src/a2a/server.ts` — creates an A2A server with skill `run_task` (input: `{ prompt: string, workspace?: string }`); calls the existing agent loop (`generator.ts`) and returns the result; if `A2A_PORT` is set, starts listening
- `src/a2a/types.ts` — shared types for A2A task input/output

**Files to modify:**
- `src/main.ts` — after CLI init, check `process.env.A2A_PORT`; if set, call `startA2AServer(agent, port)`
- `src/server.ts` — same check after HTTP server starts

**Install:**
```
npm install @a2a-js/sdk
```

**Verification:**
1. `A2A_PORT=7778 rei` (starts CLI + A2A sidecar)
2. `curl -X POST http://localhost:7778/tasks -H 'Content-Type: application/json' -d '{"skill":"run_task","input":{"prompt":"count files in src/"}}'`
3. rei executes the task and returns result
4. Laminar shows a new trace for this A2A-triggered run

---

### Iteration 3 — Days 5–6: A2A client — rei delegates to peer agents

**Goal:** rei can call another A2A agent mid-turn via a tool.

**Files to create:**
- `src/a2a/client.ts` — `sendTask(agentName, prompt): Promise<string>` — reads agent URL from config, sends A2A task, returns result text
- `src/a2a/delegate-tool.ts` — wraps `client.ts` as a rei tool (`delegate_to_agent`); registered in `generator-tools.ts`

**Files to modify:**
- `rei.config-example.json` — add `"agents": { "auditor": "http://localhost:7778" }` section
- `src/agent-mode/generator-tools.ts` — register `delegate_to_agent` tool (name, description, call handler)
- `src/tools/mcp/mcp-registry.ts` — if needed to register non-MCP tools (verify pattern first)

**Verification:**
1. Terminal A: `A2A_PORT=7778 AGENT_ROLE=auditor rei` (Auditor instance)
2. Terminal B: `rei "Ask the auditor agent to list all providers in the codebase"` (Planner instance, auditor URL in config)
3. Planner calls `delegate_to_agent`, Auditor responds
4. Laminar: **two separate traces** (not yet linked — that's iteration 4)

---

### Iteration 4 — Days 7–8: Cross-agent trace propagation

**Goal:** One unified trace in Laminar showing Planner → Auditor as parent-child spans.

**Files to create:**
- `src/telemetry/a2a-propagation.ts`:
  ```typescript
  export function injectContext(metadata: Record<string, string>): void {
    propagation.inject(context.active(), metadata);
  }
  export function extractContext(metadata: Record<string, string>) {
    return propagation.extract(context.active(), metadata);
  }
  ```

**Files to modify:**
- `src/a2a/client.ts` — call `injectContext(taskMetadata)` before sending the A2A task
- `src/a2a/server.ts` — call `extractContext(task.metadata)` on arrival; start the root span as a child of the extracted context

**Verification:**
1. Re-run the iteration 3 scenario
2. Open Laminar → Traces → **one trace** containing spans from both Planner and Auditor
3. Planner's `turn-N` span contains Auditor's `turn-1`…`turn-M` spans as children
4. `traceparent` attribute visible on the A2A task spans

---

### Iteration 5 — Days 9–10: Demo polish + LLM-call spans

**Goal:** The demo is runnable end-to-end; Laminar tells the full reasoning story.

**Work:**
- Expand span depth: inside each `turn-N` span, add a `llm-call` child span wrapping the `provider.generate()` call; add attributes: `llm.provider`, `llm.model`, `llm.input_tokens`, `llm.output_tokens`
- Add span attributes: `turn.number`, `tool.name` (on tool executions), `a2a.target_agent`, `a2a.skill`
- Write `docs/demo/planner-auditor.md` — step-by-step demo runbook (start Laminar, start two rei instances, run the prompt, show Laminar waterfall)
- Update `docs/features/multi-agent.md` with the v2 architecture

**Demo prompt (final):**
> *"I want to add a caching layer to the providers. Before planning changes, ask the auditor agent to check if any caching already exists in the codebase."*

**Final Laminar waterfall:**
```
Trace: rei-planner-invocation
  └── span: turn-1
        └── span: llm-call  [model=gemini, tokens=1200]
        └── span: delegate_to_agent  [target=auditor]
              └── span: turn-1  (Auditor)
                    └── span: llm-call  [model=gemini, tokens=800]
  └── span: turn-2
        └── span: llm-call  [model=gemini, tokens=600]
```

**Verification:**
1. `docker compose up -d`
2. Terminal A: `A2A_PORT=7778 rei` (Auditor)
3. Terminal B: `rei "I want to add a caching layer. Ask the auditor to check if any caching already exists."` (Planner)
4. Laminar: one trace, full parent-child hierarchy across both agents ✓

---

## Critical Files Summary

| File | Action |
|---|---|
| `docker-compose.yml` | Create — Laminar self-hosted stack |
| `src/telemetry/init.ts` | Create — OTel SDK bootstrap |
| `src/telemetry/a2a-propagation.ts` | Create — W3C traceparent inject/extract |
| `src/a2a/server.ts` | Create — A2A HTTP server, `run_task` skill |
| `src/a2a/client.ts` | Create — A2A HTTP client, `sendTask()` |
| `src/a2a/delegate-tool.ts` | Create — `delegate_to_agent` rei tool |
| `src/main.ts` | Modify — import telemetry, start A2A sidecar if `A2A_PORT` set |
| `src/server.ts` | Modify — same |
| `src/agent-mode/generator.ts` | Modify — wrap turns in OTel spans |
| `rei.config-example.json` | Modify — add `agents` map |
| `docs/features/multi-agent.md` | Replace — v2 plan |
