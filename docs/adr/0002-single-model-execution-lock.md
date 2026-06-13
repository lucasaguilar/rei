# 2. Single node-wide Model/Execution Lock

Date: 2026-06-13
Status: Accepted

## Context

Two efforts drive heavy local models on the same Node:

- **A2A serving** (Multi-Agent A2A + OTel plan) — a Worker runs delegated tasks through an `Agent`.
- **The Orchestrator Engine + daemon** (hardware-aware orchestration plan) — a single `Worker` drains a
  persistent queue and runs the `/auto` macro→micro pipeline, swapping a dense model and a MoE model.

The hardware reality (Mac Mini M5, 48 GB unified memory) allows **only one ~20 GB model resident at a
time**; loading a second before the first is confirmed unloaded causes OS swap and crashes. Execution can
be triggered concurrently from three sources — interactive `chat`, an inbound A2A delegation, and a
scheduled task. If A2A serving and the daemon each kept their **own** lock/queue, two heavy-model runs
could overlap → the exact failure the orchestration plan forbids.

The two plans had independently arrived at "serialize execution" — A2A for `Agent` safety, orchestration
for model-RAM safety. They are the same constraint.

## Decision

A **single process-wide Model/Execution Lock** guards all heavy-model execution on a Node. Concretely:

- **Every trigger** (interactive, A2A-inbound, scheduled) acquires the lock before running a task.
- **One Worker** drains **one persistent queue** while holding the lock; long A2A-inbound tasks **enqueue**
  into the same queue (their resumable state is the orchestration session).
- A **synchronous fast-path** for short tasks still acquires the lock (jumping the queue at high priority),
  so quick delegations feel immediate without ever overlapping a heavy run.
- The Worker calls a **`RunTask` seam** that targets either a **plain Agent Turn** (today) or the
  **Orchestrator Engine** (`/auto`) — uniformly for all triggers.
- **N = 1 per Node, permanently** (hardware-bound). Concurrency comes **only from scaling out to more
  Nodes via A2A**, never from parallel local execution.

The **lock + queue + `RunTask` seam** are the integration contract between the A2A work and the
orchestration work: either can be built first against these interfaces.

## Consequences

- ✅ No double model load; no swap-race crash.
- ✅ A2A serving and the autonomous daemon become **one subsystem**, not two competing ones.
- ✅ Reinforces SRP — one Node, one responsibility, one task at a time.
- ✅ Enables a swap-cost optimization: delegate the MoE step to a Node that already has the MoE loaded
  instead of swapping locally.
- ⚠️ A busy Node makes other triggers (and other Directors) **wait** — acceptable given SRP and scale.
- ⚠️ **No local parallelism, ever** — a deliberate consequence of the hardware, not a temporary limit.

## Alternatives considered

- **Separate locks for A2A vs daemon** — rejected: permits double model load → crash.
- **No lock, trust call ordering** — rejected: races during model load/unload.
- **Allow N>1 locally later** — rejected on this hardware; revisit only with a bigger RAM / multi-GPU box,
  at which point scale-out via A2A is still the cleaner path.
