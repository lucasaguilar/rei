# Spec-driven development in REI

How to take a non-trivial task from a vague request to a verified change, and what REI guarantees at
each step.

The short version:

```
/spec "<task>"        → the contract        (.rei/specs/<name>.md)
/role auditor         → review the contract (optional)
/decompose            → a traceable plan    (.rei/plans/<name>.md)
/saveplan <name>
/runplan stage 1..N   → implement, then test, then verify
```

## Why the flow exists

A model asked to "add X" over-interprets: "show the config values" becomes an editable, persisted
config editor. And a green build is silent about it — `tsc` answers *"did I break anything?"*, never
*"did I build what was asked?"*. Both failures are invisible without a written contract to check
against.

So the flow pins down **what** is wanted (the spec), keeps the plan tied to it (traceability), and
closes by judging the result against it (verification).

## Step 1 — the spec

```
/spec "add a status indicator to the session bar"
```

Switches to planning mode and emits a spec: Goal, In scope, **Out of scope**, numbered **Acceptance
criteria**, Constraints, Open questions. It also writes it to `.rei/specs/<name>.md`.

Two sections carry most of the value:

- **Out of scope** is the guard against scope creep. If the request says "display", this says "no
  editing, no persistence".
- **Acceptance criteria** are numbered and independently checkable. They become the test list in
  step 4 and the verdict list in step 5. Vague criteria ("works well") are rejected — they cannot be
  verified, so they cannot close the loop.

**Read the spec before continuing.** It is the contract; correcting it here is cheap, and everything
downstream is derived from it. Talk to the model to adjust it, then re-save.

### Why a command and not just asking

Skills are *offered* to the model, never imposed — it sees a catalog and decides. Asked to plan
something, a local model routinely skips `write-spec` and answers with a plan, leaving `/savespec`
with nothing to save. `/spec` injects the recipe's full body into the prompt, so the model cannot
skip a recipe that is already in its context. Same mechanism `/runplan` uses to force execution.

## Step 2 — audit the contract (optional)

```
/role auditor
"review the spec"
/role off
```

An adversarial read of the spec/plan **before** implementation: blind spots, unstated assumptions,
risky ordering. Worth it on anything touching more than a couple of files.

## Step 3 — the plan

```
/decompose
```

Turns the spec into micro-stages. Refuses if there is no spec — planning without a contract is the
drift the spec exists to prevent.

Each stage carries:

```
## Stage N: <one change>
Files to modify: src/exact/path.ts
Satisfies: AC-2                ← the traceability link
Verify: npx tsc --noEmit
Skill: <optional recipe>
Depends on: <earlier stages>
```

`Satisfies:` is required on every stage. **A stage that traces to nothing in the spec must not
exist** — that is how scope creep is caught at plan time instead of at review time.

The plan always closes with two stages the recipe adds automatically:

```
## Stage N-1: Write one test per acceptance criterion   (Skill: write-tests)
## Stage N:   Verify the implementation against the spec (Skill: verify-against-spec)
```

## Step 4 — implement

```
/saveplan my-feature
/runplan stage 1
/runplan stage 2
...
```

One stage at a time keeps the control points; `/runplan` with no stage runs the whole plan. Each
stage ends with its own `Verify:` command.

**Each stage runs in its own isolated sub-agent.** Executing a whole plan in one session means the
last stage reasons through every earlier stage's exploration — every file read, every tool result,
every diff — which is both large and mostly irrelevant to the change at hand. A stage is already the
self-contained unit delegation wants: one change, explicit files, a concrete `Verify:`. So REI hands
each one to a fresh worker and keeps only its 1–3 sentence summary.

This is decided by REI, not by the model. `delegate` is also offered as a tool, but a local model
competing with a dozen other tools essentially never picks it, so leaving the choice to it means the
isolation never happens.

Two things are deliberate:

- **A stage that depends on an earlier one receives its summary.** A fresh worker cannot see what
  stage 3 decided, so `Depends on: 3` pulls stage 3's summary into the task.
- **Report stages are never delegated.** Judging the whole change against the spec needs context a
  clean worker does not have, so `Skill: verify-against-spec` runs in the session, after the
  delegated stages and with their summaries on screen.

A failing stage stops the run: later stages would build on a broken base, and the summary of what
failed beats a pile of cascading errors. Set `REI_RUNPLAN_DELEGATE=false` for the old
single-session behaviour.

The test stage is separate from the implementation stages on purpose: tests written alongside a
change tend to assert *what the code does*, while tests written from the criteria assert *what was
asked*. Each test is named for its criterion (`criterion 3: …`) so the mapping survives without a
document.

## Keeping the spec honest — `/trace`

The flow only runs forward. A discovery made while implementing has no path back to the spec, so the
spec goes stale quietly, and Step 5 then grades the work against criteria that no longer describe it:
a criterion abandoned on purpose reads as **NOT MET**, and work the spec still excludes reads as an
out-of-scope violation. Both are wrong, and neither tells you the design changed.

`/trace` crosses the two documents deterministically — no model — in both directions:

```
[TRACE] .rei/specs/login.md ↔ .rei/plans/login.md
  4 acceptance criteria · 4 stages

  ✖ Stages naming a criterion the spec does not have — the PLAN moved ahead:
      Stage 3: Add SSO
        names AC-9

  ✖ Criteria no stage claims — the SPEC moved ahead, or the plan misses them:
      AC-3: The session survives a reload.
```

It reports and never edits: which document is wrong is a judgment call. Run it after `/decompose`,
and again whenever the plan changes mid-flight.

**Then amend the spec deliberately.** The tempting fix — editing the spec to match what you built —
makes Step 5 tautological: you are grading against a document rewritten to fit the answer. Record
*what* changed and *why* alongside the revised criteria, so an amended criterion stays visible as one
that deserves a human's attention.

`/trace <spec> <plan>` traces a pair by name instead of the active one.

## Step 5 — verify against the spec

The closing stage judges every criterion:

```
## Criterion 1 — "<verbatim>"
**MET** · src/foo.ts:41 — <what satisfies it>
Evidence: <the test that covers it>

## Criterion 3 — "<verbatim>"
**UNVERIFIED** · needs a real viewport — verify by hand
```

Three verdicts, not two. **UNVERIFIED is not a soft NOT MET** — it means the check cannot be made
from here, and marking such a thing MET is the exact failure this step exists to prevent. A
criterion whose only support is the model's own reasoning is UNVERIFIED.

The summary also reports **out-of-scope work**: changes the diff contains that the spec excluded.

`/runplan` gives this stage a different directive from the others — it must produce a report and must
NOT edit, since fixing findings mid-verification would make the report describe a moving target.

## What each control actually proves

| Control | When | Answers |
|---|---|---|
| `auditor` role | before implementing | is the plan sound? |
| each stage's `Verify:` | during | does it compile / do tests pass? |
| `verify-against-spec` | after | was the request satisfied? |

The middle one is the one most projects have, and it is the one that cannot notice a dropped
criterion.

## Honest limits

- **A verdict is not proof.** Only a passing test is. Treat the report as a coverage statement —
  *"3 of 5 criteria have a test; 2 need a human"* — not as a seal of approval.
- **Not every criterion is testable.** UI, performance and third-party behaviour land in UNVERIFIED.
  The value is that the gap becomes explicit instead of assumed.
- **`/trace` only checks what is numbered.** A stage tracing to an in-scope item instead of an
  `AC-N` is legitimate and is reported as unchecked, not as a pass — the report says how many stages
  it could actually cross.
- **The model can still not follow a recipe.** `/spec` and `/decompose` guarantee the recipe is
  *present*, not that it is obeyed. With a small local model, check the first output of each step;
  the recipes are markdown in `prompts/skills/`, so tuning the wording costs nothing.

## Where things live

| Path | What |
|---|---|
| `.rei/active.json` | **which spec and plan are active** — names, not copies |
| `.rei/specs/<name>.md` | saved specs |
| `.rei/plans/<name>.md` | saved plans |
| `.rei/current-plan-content.md` | legacy fallback for sessions predating the pointer |
| `prompts/skills/write-spec.md` | the spec recipe |
| `prompts/skills/micro-task-decomposition.md` | the plan recipe |
| `prompts/skills/write-tests.md` | tests, spec-aware |
| `prompts/skills/verify-against-spec.md` | the verification recipe |
| `prompts/roles/auditor.md` | the audit posture |

In planning mode REI can write to `.rei/specs/`, `.rei/plans/` and `docs/` — enough to persist the
flow's artifacts — and nothing else. Source changes require agent mode. The scope is enforced when a
write executes (`src/agent-mode/tools-loop/write-scope.ts`), not by hiding the tools, so a refusal
tells the model where it *may* write.

## Which spec and plan are active

`.rei/active.json` records the **names** of the spec and plan in play. It is a pointer, never a copy,
so nothing can go stale against the file it names — editing `.rei/plans/x.md` changes what runs.

It is set by every command that produces or selects an artifact: `/spec` and `/decompose` name and
activate what they create; `/savespec`, `/loadspec`, `/saveplan` and `/loadplan` activate what they
touch. **Saving activates** — the earlier split, where a saved plan was not the plan that ran, is the
bug this removes.

`/active` shows what is pointed at (and warns when a pointer outlived its file); `/active clear
[spec|plan]` unsets it. Finishing a plan does NOT clear it — re-running a stage is normal — so clear
it when a feature is done, or a later `/runplan` will execute the old plan against new work.

`/runplan` resolves its source in this order, and names the one it used before executing:

1. the active plan's file
2. the newest session message that looks like a plan (heuristic — reported as "no active plan set")
3. `.rei/current-plan-content.md`

Under the old behaviour the heuristic came first, so a message merely *quoting* a plan — a recap, a
summary — could outrank the plan on disk, and the mismatch surfaced only as "Stage 1 was not found".

## Commands

| Command | Step |
|---|---|
| `/spec <task>` | write the contract |
| `/savespec <name>` · `/loadspec <name>` | persist / bring one back |
| `/role auditor` · `/role off` | audit before implementing |
| `/decompose` | spec → traceable plan |
| `/saveplan <name>` · `/loadplan <name>` | persist / bring one back |
| `/runplan [stage <n>]` | execute all, or one stage |
| `/active` · `/active clear [spec\|plan]` | see or unset what is active |
| `/trace [<spec> <plan>]` | cross the spec's criteria against the plan, both ways |
| `/think <level>` | change the reasoning budget mid-session |
