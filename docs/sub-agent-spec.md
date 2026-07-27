# Mini-spec: isolated-context sub-agents (local-model optimization)

Status: **SPEC (defined, not implemented).**

## Goal & thesis

The #1 constraint on local models is the **context window** (small windows, drift, the pain we built
`/tree prune` and lean-history for). An isolated-context sub-agent runs a well-specified subtask in a
**fresh, minimal context** and returns only a **compact result** — so:
- the **worker** works in a clean small window (never inherits the orchestrator's 20-30k-token history);
- the **orchestrator** stays lean (absorbs only the summary, not the worker's exploration).

This is context isolation **both ways** — the highest-leverage local optimization available. It's the
**vision-sidecar generalized**: REI already delegates a specialized subtask (image→text via
`REI_VISION_MODEL`) in a separate call; a sub-agent is that idea for *any* subtask, running a full agent
loop. Model-swap is optional (the user already swaps models for OCR without issue).

Not the Minions cost play (that's a cloud-bill optimization; irrelevant to pure-local). Here the win is
**context + speed + reliability-via-specification**, with ONE model loaded (worker can reuse the same
model — size is optional).

## Two triggers (mirrors the ask_user/elicitation design)

| Trigger | Who delegates | Path |
|---|---|---|
| **Model-triggered** — a `delegate` tool | the orchestrator MODEL decides to delegate | flexible |
| **REI-triggered** — `/runplan` stages | REI runs each decomposed stage as a sub-agent | deterministic, reliable on weak local models |

Both call the SAME sub-agent runner. `/runplan` is the reliable local path: `micro-task-decomposition`
already produces the fully-specified stages (the "orchestrator designed everything" half); running each
in an isolated context is the missing "execute" half. The `delegate` tool is the model-driven path.

## The `delegate` tool (model-triggered)

```
delegate({
  task: "implement validateEmail in src/auth.ts per this contract: …",
  files?: ["src/auth.ts", "src/types.ts"],   // what the orchestrator already prepared
  model?: "qwen-small"                         // optional worker model (the OCR-style swap)
})
```
Returns a compact result string (the worker's summary of what it did). File edits land on disk (shared
workspace) — the summary just names them; no merge.

## The sub-agent runner (the core)

`runSubAgent({ task, files, model, workspacePath, depth }) → Promise<string>`:
1. **Fresh session** — a new `ChatSession` with a focused "worker" system prompt + the task; the named
   `files` are injected (read once) so the worker starts with exactly what it needs.
2. **Run the existing loop** — `agent.streamTurn(freshSession, taskPrompt)` (the internal tool-loop
   already does read→edit→verify up to MAX_TURNS until a final text answer). Consume the stream,
   accumulate the final text.
3. **Return the compact result** — the worker's final answer. Disk holds the edits.

Reuses `Agent` / `executeAgentTurnWithTools` / the session model / the provider factory almost entirely.
The worker gets its own turnId, produce-or-bail guard, and destructive-command gate (all inherited).

## Context marshaling (the hard part — where the value lives)

This, not the plumbing, is the real work:
- **In:** worker system prompt (role: "execute THIS task only, don't explore beyond it") + the task +
  the injected `files` the orchestrator chose. NOT the orchestrator's history.
- **Out:** a compact summary (what was done + files touched). NOT the worker's transcript. The
  orchestrator's context grows by ~a paragraph, not by the whole sub-run.

Getting "what goes in / what comes back" right is what makes the isolation pay off.

## Safety & guards

- **Depth-1 (v1): a sub-agent CANNOT spawn sub-agents** — no `delegate` in the worker's toolset. Blocks
  infinite delegation.
- Worker has its OWN turn budget (`REI_MAX_TURNS`) and inherits the produce-or-bail + destructive-command
  gate. (The destructive gate's `elicit` bubbles to the same single UI owner as the orchestrator.)
- Worker model resolved via the provider factory (`model` param or `REI_SUBAGENT_MODEL`, else the mode
  model). Model-swap latency is the user's choice (fine for OCR-style specialized workers).
- UX: orchestrator pauses; user sees `🤖 [REI] Delegating: <task>…` (emitStatus), then the compact result.

## Config
| Var | What | Default |
|---|---|---|
| `REI_SUBAGENT_MODEL` | default worker model when `delegate` omits `model` | the current mode's model |
| `REI_SUBAGENT_MAX_TURNS` | worker turn budget | `REI_MAX_TURNS` |

## Phases & effort

Honest estimate: bigger than the incremental work (config/elicitation/gates), but the heavy reuse of
`Agent`/`streamTurn` keeps Phase 1 tractable — roughly the size of the ask_user+elicitation arc.

1. **Phase 1 — core runner + `delegate` tool (same model, depth-1).** `sub-agent-runner.ts` (fresh
   session + consume streamTurn + capture result) + `DELEGATE_TOOL` def + handler + dispatch case +
   depth guard + directive line. Tests: runner returns the worker's final text; depth-1 (worker has no
   delegate); result is compact. — *the meaningful chunk; delivers the context-isolation win with one model.*
2. **Phase 2 — worker model swap.** `model` param / `REI_SUBAGENT_MODEL` → provider factory. Small.
3. **Phase 3 — `/runplan` runs stages as sub-agents.** The deterministic local path; wires the runner
   into plan execution. Medium.
4. **Phase 4 — marshaling polish.** Better file-change tracking in the summary, richer worker prompt,
   depth-N if ever needed. Later.

Stop after Phase 1 and REI already has isolated-context delegation.

## Does it add up for local? (the honest yes)

Yes — strongly, because it attacks the *actual* local bottleneck (context), not a cloud cost. Caveat:
the model-triggered `delegate` depends on the orchestrator choosing to delegate well (weak local models
may under-use it — same as ask_user). That's why the **`/runplan` deterministic path (Phase 3)** matters:
it delivers the isolation without relying on the model's judgment — the verifier-in-loop philosophy.

## Connections
`[[rei-sdd-skills-layer]]` (micro-task-decomposition = the stage specs) · `[[rei-context-drift]]` /
`[[rei-lean-history-demotion]]` (the context bottleneck this attacks) · `[[rei-multimodal-image-input]]`
(the vision sidecar = the pattern's seed) · `docs/features/Multi-Agent A2A + OTel.md` (orchestration).
