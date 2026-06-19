# 1. A2A serving concurrency model

Date: 2026-06-13
Status: Accepted

## Context

A rei A2A Node serves tasks delegated by other Nodes (Orchestrators). Several forces collide:

- **`Agent` is not concurrency-safe.** It carries per-Turn mutable state (`correlationId`,
  `pendingHardwareWarnings`, the per-Turn logger) and mutates the passed `ChatSession` in place.
  Two overlapping Turns on one `Agent` corrupt each other.
- **Requests can arrive from multiple Orchestrators**, and a rei Node also serves A2A *while* its
  own interactive REPL Turn may be running — so concurrent arrival is real, not hypothetical.
- **Open/Closed:** we do not want the A2A protocol layer to bake in a "single serial client"
  assumption that forces a rewrite when rei later supports concurrent execution.
- **Single Responsibility:** a Node does one focused job, so deep request fan-in on a single Node
  is not the common case — serialization is rarely a throughput bottleneck in practice.

Constructing a fresh `Agent` per request is too heavy: each one spins up a `VectorStore`, an
`McpRegistry` (which spawns MCP servers), a file watcher, etc.

## Decision

**Phase 1 — serial + synchronous serving:**

- Each Node hosts **one long-lived dedicated serving `Agent`**, separate from the interactive Agent.
- Each served task runs on a **fresh `ChatSession`** (no memory carried between requests; requests
  from different Orchestrators never share session state).
- Tasks are **serialized behind a mutex** (effective `concurrency = 1`). A second arrival is
  **accepted, not rejected** — it waits its turn.
- Serving is **synchronous**: the Worker runs the task to completion and the Orchestrator's
  `delegate_to_agent` awaits the bounded result (deadline-guarded).

The seam that keeps us open: a **`TaskExecutor` abstraction keyed by A2A task id**. "Serial" is the
worker count behind that seam, not an assumption in the protocol/dispatch code.

**Phase 2 — concurrent serving (future, not built):** raise worker `concurrency = N`, add async
accept/ack (return a task id immediately), a real queue, polling / push-notification completion, and a
turn-stateless `Agent`. None of this touches the Phase-1 protocol surface or the delegate tool.

## Consequences

- ✅ Simple and safe now; no data races; no per-request Agent construction cost.
- ✅ OCP preserved — concurrency is additive later via the `TaskExecutor` seam.
- ✅ "Accepts-but-serializes" matches the stated intent ("multi-request in the future").
- ⚠️ A busy Node makes other Orchestrators **wait**; acceptable given SRP Nodes and the demo scale.
- ⚠️ True concurrent serving is deferred and depends on making `Agent` turn-stateless (tracked as
  Phase-2 debt).

## Alternatives considered

- **Fresh `Agent` per task** — rejected: too heavy (MCP servers / VectorStore per request).
- **Reuse the interactive `Agent`** — rejected: concurrency corruption of live session state.
- **Build the concurrent queue now** — rejected: needs a turn-stateless `Agent`; out of scope for
  the demo and against "keep the initial stage simple."
