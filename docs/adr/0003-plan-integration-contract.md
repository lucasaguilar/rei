# 3. Plan Integration Contract (code-as-contract firewall)

Date: 2026-06-13
Status: Accepted

## Context

Three things evolve at once: the **A2A + OTel** plan, the **hardware-aware Orchestration** plan, and
rei's **core** (`agent.ts`, the generators, the dispatchers, the entry points), which the orchestration
work will reshape. We want to build the A2A/observability modules **now**, in parallel, **without waiting
for rei's final structure** and without merge hell when it changes.

The two plans already converged on shared seams — a `RunTask` execution entry point, a single
`ExecutionLock`, a persistent `TaskQueue`, A2A metadata, and a span taxonomy for the unified trace
(see [ADR 0001](0001-a2a-serving-concurrency.md), [ADR 0002](0002-single-model-execution-lock.md)). The
question is how to make those seams *binding* across plans rather than re-described (and drifting) in each.

## Decision

Materialize the seams as **code, not prose**: a single module
[`src/contracts/execution-contract.ts`](../../src/contracts/execution-contract.ts) holding
`RunTask`, `ExecutionLock`, `TaskQueue`/`QueuedTask`, `A2AMeta`, `A2ANodeMap`, `ModelLifecycle`, and the
**normative `SpanName` / `SpanAttr` taxonomy**.

- **Dependency Inversion:** the contract imports **nothing** from rei. Both plans **and** rei's core
  depend on the contract; never the reverse. The firewall is enforced by review/CI.
- **Span taxonomy is inside the contract** (not a loose convention), so "one unified trace" is
  compiler-anchored across both plans.
- **Build in two waves by coupling:** Wave 1 = everything that speaks only the contract (telemetry, A2A
  client/server with an *injected* seam, minimal lock/queue, provider decorator) — built now and tested
  against a mock `RunTask`. Wave 2 = the thin glue that touches rei's in-flux core — built when it settles.
- **Stability policy:** the contract stays small; prefer additive changes; a breaking change is a
  cross-plan decision.

## Consequences

- ✅ A2A + OTel modules build and unit-test **today**, isolated from rei's evolving core.
- ✅ Either plan can be built first; the other binds to the same interfaces unchanged.
- ✅ Low coupling by construction — `a2a/server.ts` never imports `Agent`; the decorator wraps an interface.
- ✅ The unified trace is enforced by a shared taxonomy, not hope.
- ⚠️ One extra indirection layer; the contract itself becomes a coordination point that must be kept
  minimal and stable (mitigated by the stability policy).

## Alternatives considered

- **Doc-only contract** — rejected: not compiler-enforced; drifts.
- **No contract, code directly against `Agent`/generators** — rejected: high coupling, can't build before
  rei settles, merge hell.
- **Duplicate the interfaces inside each plan's module** — rejected: two sources of truth, guaranteed drift.
