---
name: micro-task-decomposition
description: Break a plan's stages into the smallest atomic, independently-verifiable tasks so a local model can implement them one at a time
modes: planning
---

# Skill: Micro-task decomposition

Use when producing an implementation plan that REI will execute stage by stage (via `/runplan`).
Local models thrash on big tasks and nail small ones — so the plan must be sliced into the
**smallest atomic units** that still compile and verify on their own. Task size is also the unit
of resource scheduling: a smaller task needs less context and less compute, so it fits the
machine's window and memory budget.

## If a spec is present (it is the contract)

If a spec (Goal / In scope / Out of scope / Acceptance criteria — from the `write-spec` skill) exists
in the conversation or context, it governs the plan:

1. **Trace every stage** to an acceptance criterion or an in-scope item — every stage MUST carry a
   `Satisfies:` line naming the criterion/scope item it serves (e.g. `Satisfies: AC-2`). This is not
   optional and not only for the final stage. A stage that traces to nothing in the spec does not belong.
2. **Never plan an Out-of-scope item.** If the work seems to need one, STOP and raise it as an open
   question instead of silently adding it. This is the guard against scope creep.
3. **Verify the acceptance criteria, not just compilation.** Add final verification stage(s) that
   actually check each acceptance criterion (a test, a manual check), beyond `ngc`/`tsc` passing.
4. **Do NOT silently resolve the spec's Open Questions.** If an Open Question affects the plan (e.g.
   "integrate into the existing page OR a new route?"), do not just pick an answer and bury it in a
   stage. Either (a) STOP and ask the user to decide before decomposing, or (b) if you must proceed,
   state the choice explicitly at the TOP of the plan under an `## Assumptions` heading
   (e.g. "Assumed (Open Q1): integrate into AboutComponent"), so the deviation is visible and the user
   can correct it before running `/runplan`.

If no spec exists, plan directly from the prompt — but consider suggesting `write-spec` first when the
task is non-trivial or its scope is fuzzy.

## What "micro" means (hard rules, not aesthetics)

A stage is micro ONLY if it satisfies ALL of these:

1. **One file** ideally — at most 2-3 if they are tightly coupled (e.g. a type + its single consumer).
2. **One logical change** — one function, one component, one type, one config edit. If a stage needs
   the word "and" to describe it, split it.
3. **Independently verifiable** — after this stage alone, the project still compiles / its test passes.
   No stage may depend on a *later* stage to build. **Co-validated artifacts = one stage:** if
   splitting file A from file B means A's correctness is only checked once B lands, they are a single
   atomic unit — keep them together. Beware the **false green**: a `Verify:` that passes trivially
   because nothing references the new file yet (an unused export, an orphan template/asset) has
   verified *nothing*. The real check happens when the consumer lands — so put them in the same stage.
   (Framework-specific cases live in the project rules in your context, e.g. an Angular component's
   class+template+styles are one unit — follow those when present.)
4. **Bounded context** — the files it touches plus their direct dependencies fit comfortably in the
   model's context window. If reading the needed files would blow the budget, the stage is too big.
5. **Atomic / reversible** — it is a single commit-worthy unit. One stage = one coherent diff.

If a candidate stage breaks any rule, **split it further** until every stage passes all five.

## How to decompose

1. Start from the high-level goal and the relevant files (the plan's "Relevant files" section).
2. List the changes needed end to end, ignoring size.
3. Order them by dependency: a stage may only depend on *earlier* stages, never later ones.
4. Slice each change down until it satisfies the five rules above.
5. For each resulting micro-stage, write it in the standard plan format.

## Output: each micro-stage

Emit every stage as an H2 so `/runplan` parses it. Include the files and how it is verified:

If you had to assume an answer to any of the spec's Open Questions, list them first:

```
## Assumptions
- (Open Q1) <the question> → <the choice you made>
```

Then each stage:

```
## Stage N: <imperative, single-change title>
Files to modify: src/exact/path.ts
Change: <the one logical change, in 1-2 sentences>
Satisfies: <AC-N or the in-scope item this stage serves — REQUIRED when a spec is present>
Verify: <the exact command that confirms this stage compiles/passes — e.g. npx ngc -p tsconfig.app.json --noEmit>
Skill: <optional — the agent-mode skill to use when implementing this stage, e.g. angular-component-refactor>
Depends on: <earlier stage numbers, or "none">
```

Rules for the output:
- Title must describe exactly ONE change. No "and".
- `Files to modify:` lists full relative paths (with extensions) so `/runplan` loads the right context.
- `Satisfies:` is REQUIRED on every stage when a spec is present — name the AC or in-scope item. A
  stage that satisfies nothing in the spec must not exist.
- `Verify:` is concrete and project-type aware (Angular → `ngc -p tsconfig.app.json --noEmit`;
  plain TS → `tsc --noEmit`; tests → the repo's test command).
- `Skill:` is optional — name an agent-mode skill only if one fits, so execution loads the right recipe.
- Prefer MANY tiny stages over few big ones. Ten 1-file stages beat three 4-file stages.

## Anti-patterns (reject these)

- "Refactor the auth module" → too big; split per file / per function.
- A stage whose `Verify:` only really checks something once a *later* stage lands (orphan template,
  unused export, asset nothing imports yet) → **false green**; merge it with its consumer into one stage.
- A stage you can only describe with the word **"and"** (e.g. "add the route **and** the nav item")
  → two logical changes; split into two stages.
- "Update all components to use the new signal" → one stage per component.
- Bundling the implementation and its tests in one stage → separate stages (implement, then test).
