# Plan: Multi-Agent Observability Demo (MVP)

## Context

Developers running autonomous agents face a debugging gap: when agents delegate work to other agents (potentially on different machines), existing observability tools lose the thread. The A2A protocol has no built-in observability hooks — trace context does not propagate automatically across agent boundaries.

This project fills that gap with the minimum viable demo:
- Two agents communicating via A2A
- Full cross-machine trace visibility in a single Laminar UI
- Using OpenTelemetry as the universal transport — no proprietary lock-in

The philosophy: **build on giants**. OTel for instrumentation, A2A for agent communication, Laminar as the backend. We only build what doesn't exist: A2A trace context propagation.

---

## Why Laminar

- **Apache 2.0** — safe to build adapters on top and distribute
- **OTel-native** — accepts any OTLP-compatible source (gRPC or HTTP). Any language, any framework.
- **Claude Agent SDK auto-instrumentation** — zero manual wrapping for Claude agents
- **W3C traceparent** — standard OTel context propagation, no custom metadata hacks
- **Self-hostable** via Docker Compose, all features included

---

## What We Are NOT Building

- A replacement for Laminar, OpenTelemetry, Grafana, or Jaeger
- A new observability protocol
- Any component that modifies agent business behavior

---

## MVP Scope

Two agents, two machines (or two processes), one unified trace in Laminar.

**Agent 1 — Library DB Agent**
- Custom TypeScript agent (A2A server)
- Handles tasks: `find_book`, `add_book`
- Emits OTel spans, parented to Agent 2's trace via W3C `traceparent`

**Agent 2 — Task Agent**
- Claude-based agent (A2A client)
- Has a task that requires a library lookup
- Auto-instrumented by Laminar SDK (no manual wrapping needed)
- Propagates W3C `traceparent` in the A2A task request

**Expected Laminar output:**
```
Trace: task-agent-run
  └── span: claude-thinking
  └── span: agent2-delegating
        └── span: agent1-find_book       ← child span from Agent 1 (different machine)
              └── span: agent1-db-lookup
  └── span: claude-response
```

---

## Stack

- **Language:** TypeScript
- **A2A:** `@a2a-js/sdk` — official SDK, v0.3 stable
- **Observability transport:** OpenTelemetry (`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`)
- **Agent 2 instrumentation:** `@lmnr-ai/lmnr` — auto-instruments Claude/Anthropic API calls
- **Backend:** Laminar self-hosted via Docker Compose

---

## The Key Technical Piece: W3C traceparent Through A2A

OTel uses the W3C `traceparent` header for context propagation. A2A uses HTTP/JSON. The missing piece: inject `traceparent` into the A2A task request; extract it on the receiving end.

**Agent 2 — inject active OTel context into A2A task:**
```typescript
import { propagation, context } from '@opentelemetry/api';

const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
// carrier now contains: { traceparent: '00-<traceId>-<spanId>-01' }

const task = await a2aClient.sendTask({
  skill: 'find_book',
  input: { query: 'TypeScript handbook' },
  metadata: { ...carrier }   // standard W3C headers passed through A2A metadata
});
```

**Agent 1 — extract context and create child span:**
```typescript
import { propagation, context, trace } from '@opentelemetry/api';

const parentCtx = propagation.extract(context.active(), task.metadata);
const span = trace.getTracer('agent1').startSpan('find_book', {}, parentCtx);
```

This is pure OpenTelemetry — no Laminar-specific code in the propagation layer. Any OTel-compatible backend works as a drop-in replacement.

---

## Repository Structure

```
/
├── packages/
│   ├── agent-library/          # Agent 1 — Library DB Agent (A2A server)
│   │   ├── src/
│   │   │   ├── index.ts        # A2A server entry point + OTel setup
│   │   │   └── handlers.ts     # find_book / add_book with OTel spans
│   │   └── package.json
│   │
│   ├── agent-task/             # Agent 2 — Claude Task Agent (A2A client)
│   │   ├── src/
│   │   │   ├── index.ts        # Laminar init + agent entry point
│   │   │   └── task.ts         # Task logic with A2A delegation
│   │   └── package.json
│   │
│   └── shared/                 # Shared A2A context propagation utilities
│       ├── src/
│       │   └── a2a-propagation.ts   # injectContext() / extractContext()
│       └── package.json
│
├── docker-compose.yml          # Self-hosted Laminar
├── .env.example                # LAMINAR_API_KEY, OTEL_EXPORTER_OTLP_ENDPOINT
└── README.md
```

---

## shared/a2a-propagation.ts

The only novel code in this project — everything else is wiring existing libraries.

```typescript
import { propagation, context } from '@opentelemetry/api';

export function injectContext(metadata: Record<string, unknown>): void {
  propagation.inject(context.active(), metadata as Record<string, string>);
}

export function extractContext(metadata: Record<string, unknown>) {
  return propagation.extract(context.active(), metadata as Record<string, string>);
}
```

---

## Files to Create

| File | Purpose |
|---|---|
| `docker-compose.yml` | Self-hosted Laminar stack |
| `packages/shared/src/a2a-propagation.ts` | `injectContext` / `extractContext` — the core missing piece |
| `packages/agent-library/src/index.ts` | A2A server, OTel exporter pointed at Laminar |
| `packages/agent-library/src/handlers.ts` | `find_book` / `add_book` handlers with child spans |
| `packages/agent-task/src/index.ts` | Laminar init (auto-instruments Claude), creates root trace |
| `packages/agent-task/src/task.ts` | Task logic with delegation via A2A + context injection |

---

## Verification

1. `docker compose up` — start Laminar
2. `cd packages/agent-library && npm start` — Agent 1 running (machine A or port 3001)
3. `cd packages/agent-task && npm start` — Agent 2 running (machine B or port 3002)
4. Agent 2 runs its task, hits the delegation point, calls Agent 1 via A2A
5. Open Laminar UI → Traces → find the single trace showing the full nested tree
6. Confirm Agent 1's spans appear as children of Agent 2's delegation span — connected across machines

**Success criterion:** one Laminar trace, two agents on different machines, parent-child relationship intact, using only standard OTel and A2A primitives.
