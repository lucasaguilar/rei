# REI Refactor Plan — simplify for readability, debuggability & small PRs

Status: **proposed**. Goal: code that's easy to read, easy for the author to debug, with
reviewable PRs of **≤ 300–400 lines**, **without changing behavior**.

## The problem (grounded in the codebase, 2026-06)

23,437 lines / 145 source files — a *manageable* codebase. Complexity is **concentrated in a
few giant procedural functions**, not spread out:

| File | Lines | The offender |
|---|---|---|
| `core/agent.ts` | 1272 | `Agent` god-class: MCP + RAG + repo-map + watcher + turn orchestration |
| `agent-mode/generator.ts` | 1161 | `executeAgentTurn` (~630 lines) + `executeAgentTurnWholefile` (~426) |
| `agent-mode/generator-tools.ts` | 1100 | `executeAgentTurnWithTools` — **one ~920-line function** |
| `chat/menu-command-processor.ts` | 1030 | `processMenuCommand` — a ~960-line if/else over ~30 commands |

These 4 files ≈ 20% of the code. Only 8 files exceed 400 lines. So the refactor is **focused,
not sweeping**: break the giant functions into small, named, testable pieces.

## Design principles — the "bases" (apply to ALL new + refactored code)

1. **Single Responsibility.** One module / one function = one job.
   Targets: **files ≤ 300 lines, functions ≤ ~60 lines, ≤ 3 levels of nesting.**
2. **Layered boundaries, dependencies point inward.** `cli → chat → core/agent → providers /
   tools / context`. No import cycles. Inner layers never import outer ones.
3. **Pure core, I/O at the edges.** Extract decision logic into **pure functions** (trivial to
   test + step through in a debugger). Keep fs / network / process calls at module boundaries.
4. **Compose, don't accumulate.** A long flow is a **sequence of small named steps**, never one
   900-line function. The reader should follow the steps top-to-bottom.
5. **Registry / strategy over if/else chains.** Dispatch via maps/interfaces. REI already does
   this well for **providers** and **compile adapters** — extend the same pattern to **commands**
   and **agent-loop phases**.
6. **Tests are the safety net.** Refactor only **behavior-preservingly**. Where coverage is thin
   around a target, add **characterization tests first** (lock current behavior), then refactor.
   The full suite stays green across every PR.
7. **Reads like prose.** Names state intent; comments explain **WHY**, not WHAT; delete
   dead/commented-out code as you pass through it.

## PR discipline — Definition of Done (every refactor PR)

- **One concern.** Diff **≤ 400 lines** (aim ≤ 300).
- **Behavior-preserving.** No test changes except *additions*; `tsc` clean; **full suite green
  before AND after**. Sync to `~/.rei` as usual.
- Title: `refactor(<area>): <what moved> — no behavior change`.
- If a behavior change sneaks in, it's a **separate PR** (and a separate commit) — never mix.

## What NOT to do
- No big-bang rewrites. Move code in small, reversible steps.
- Don't over-abstract: extract a seam only when a file/function is genuinely too big or unclear.
- Keep the patterns that already work (provider factory, compile adapters, the OCR/skill modules).

## Roadmap — phased, each phase = several ≤400-line behavior-preserving PRs

### Phase 0 — Guardrails (do FIRST; 1–2 small PRs)
- A lint/CI check that **warns on files > 400 lines** (prevents regression) + a simple
  **import-cycle** check.
- **Characterization tests** around the public entry points of the big 4 (lock behavior before
  touching them).
- A one-page **module/dependency map** in `docs/`.

### Phase 1 — `menu-command-processor.ts` → command registry  ⭐ START HERE
Lowest risk, highest clarity win. A 960-line if/else dispatching ~30 commands.
- Define `CommandHandler { match(input): boolean; run(ctx): Promise<CommandResult> }` + a registry array.
- Move commands out in **groups, one PR each**: session · plan · spec · mode · ask/read-document ·
  index/tdd/help · misc.
- End state: `processMenuCommand` = a thin **dispatcher (~40 lines)** + N small handler files.
- ~6–8 PRs.

### Phase 2 — `executeAgentTurnWithTools` (the ~920-line function)
- Extract the native tool loop into **named phases**: `buildTools` · `callModel` ·
  `parseToolCalls` · `applyEdits` · `verify` · `continuation/dedup`, each a small function in
  `agent-mode/tools-loop/`.
- ~5 PRs.

### Phase 3 — `generator.ts` (`executeAgentTurn` + `executeAgentTurnWholefile`)
- Extract shared turn scaffolding; converge the two paths onto common steps. Aligns with the
  pending shared-exec-engine work (see memory `rei-agent-loop-shared-engine-phase2`).
- ~4 PRs.

### Phase 4 — `core/agent.ts` god-class
- Split concerns: a `TurnOrchestrator` (the `*TurnInternal` streaming logic) vs infra
  collaborators (MCP registry, RAG/vector store, repo-map, file watcher). `Agent` becomes a thin
  coordinator wiring them together.
- ~4 PRs.

### Phase 5 — Mid-tier (opportunistic, as touched)
- `tools/command-executor.ts` (665) · `tools/repo-map-generator.ts` (592) ·
  `tools/vision-sidecar.ts` (501): split by responsibility when a change brings you there.

## Sequencing & safety
- Do phases **in order** (Phase 1 is safest + most valuable). Within a phase, **one group per PR**.
- **Never** refactor + change behavior in the same PR.
- After each PR: full suite green, `tsc` clean, synced. If a refactor needs a behavior tweak to
  proceed, land the tweak as its own small PR first.
