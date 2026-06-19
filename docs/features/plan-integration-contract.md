# Plan Integration Contract

> The stable **firewall** between the [Multi-Agent A2A + OTel plan](<Multi-Agent A2A + OTel.md>)
> and the [hardware-aware Orchestration plan](rei-plan-orchestration.md).
> Normative interfaces live in code: [`src/contracts/execution-contract.ts`](../../src/contracts/execution-contract.ts).
> Decision record: [ADR 0003](../adr/0003-plan-integration-contract.md). Glossary: [CONTEXT.md](../../CONTEXT.md).

---

## Why this exists

rei's core (`agent.ts`, the generators, the dispatchers, the entry points) is **in flux** — the
Orchestration plan will reshape it. We do **not** want to wait for that to settle before building the
A2A + OTel and observability work. The contract is the answer: a small set of interfaces that **both
plans and rei's core depend on**, so each side can be built and tested **in parallel, in isolation**.

**Dependency Inversion (the firewall rule):** the contract module imports **nothing** from rei. rei
modules import the contract; never the reverse. This is enforced by review/CI. Consequence: everything
that speaks only the contract has **zero coupling to rei's evolving internals**.

```
        ┌─────────────── src/contracts/execution-contract.ts ───────────────┐
        │  RunTask · ExecutionLock · TaskQueue · A2AMeta · A2ANodeMap        │
        │  ModelLifecycle · SpanName · SpanAttr   (imports NOTHING from rei) │
        └───────────────▲───────────────────────────────▲──────────────────┘
                        │ depends on                     │ depends on
     ┌──────────────────┴───────────┐        ┌───────────┴───────────────────┐
     │ A2A + OTel (Wave-1 modules)  │        │ Orchestration plan + rei core  │
     │ telemetry · a2a server/client│        │ Orchestrator Engine · daemon   │
     │ lock(min) · queue(min)       │        │ queue(real) · model lock(real) │
     └──────────────────────────────┘        └────────────────────────────────┘
```

## Ownership

For each interface: who provides the **implementation**, who **consumes** it.

| Interface | Implementation owner | Consumers |
|---|---|---|
| `RunTask` | **Orchestration** (Agent Turn now → Orchestrator Engine later) | A2A server, daemon, interactive |
| `ExecutionLock` | **Orchestration** (model lock) | every trigger (A2A, daemon, interactive) |
| `TaskQueue` / `QueuedTask` | **Orchestration** (durable daemon queue) | A2A-inbound (producer), daemon Worker (consumer) |
| `ModelLifecycle` | **Orchestration** (providers implement) | `withTelemetry` decorator (must forward) |
| `A2AMeta`, `A2ANodeMap`, depth cap | **A2A** | propagation, client, server |
| `SpanName` / `SpanAttr` | **shared** (A2A owns turn/step/llm/tool/delegate; Orchestration owns orchestration/macro/micro/ast/git/swap/cooling) | all instrumentation |

## Build order (reordered by coupling)

### Wave 1 — behind the firewall (build **now**; rei-structure-independent)
Speaks only the contract + stable rei surfaces (`ModelProvider` interface, `ReiConfig`) + external libs.
Unit-tested against a **mock `RunTask`**.

- `src/contracts/execution-contract.ts` — the contract (done).
- `src/telemetry/{init,spans,a2a-propagation}.ts` — OTel bootstrap, span helpers over `SpanName`, W3C inject/extract.
- `ExecutionLock` + `TaskQueue` **minimal** implementations (in-process mutex; in-memory/simple-disk queue).
- `src/a2a/server.ts` — `startA2AServer({ runTask, lock, queue, card })`; the seam is **injected**, so it
  **never imports `Agent`**.
- `src/a2a/client.ts` — `sendTask` with delegation-depth cap + cold-load-aware deadline; reads `a2aNodes`.
- `withTelemetry(provider)` — wraps the `ModelProvider` interface; **forwards `ModelLifecycle`**; emits `model-swap` span.
- `ReiConfig.a2aNodes` (imports `A2ANodeMap`) + `getA2ANodes()`; `docker-compose.yml` (Laminar).

### Wave 2 — the glue (build when rei's structure **settles**)
The only code that touches rei's in-flux core.

- The `RunTask` adapter binding the seam to real execution (`agent.runTurn` → Orchestrator Engine).
- Root/Step span instrumentation inside `agent.ts` + the three loops; Orchestration/Macro/Micro spans.
- The unified `dispatchBuiltinTool` + `delegate_to_agent` registration into the live dispatch paths.
- Starting A2A serving from `rei server` → `rei daemon`.

### Convergence
The Orchestration plan supplies the **real** `RunTask` (Orchestrator Engine), `ExecutionLock` (model lock)
and `TaskQueue` (durable daemon queue). **Wave-1 code binds to them unchanged** — that is the whole point.

## Stability policy

The contract is load-bearing for both plans, so it must stay **small and stable**. Changing it ripples to
both sides — prefer **adding** optional fields over changing existing shapes. Treat a breaking change to
this module as a cross-plan decision (new ADR).
