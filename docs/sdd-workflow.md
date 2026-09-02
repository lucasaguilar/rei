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

The test stage is separate from the implementation stages on purpose: tests written alongside a
change tend to assert *what the code does*, while tests written from the criteria assert *what was
asked*. Each test is named for its criterion (`criterion 3: …`) so the mapping survives without a
document.

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
- **The model can still not follow a recipe.** `/spec` and `/decompose` guarantee the recipe is
  *present*, not that it is obeyed. With a small local model, check the first output of each step;
  the recipes are markdown in `prompts/skills/`, so tuning the wording costs nothing.

## Where things live

| Path | What |
|---|---|
| `.rei/specs/<name>.md` | saved specs |
| `.rei/plans/<name>.md` | saved plans |
| `.rei/current-plan-content.md` | the plan `/runplan` executes |
| `prompts/skills/write-spec.md` | the spec recipe |
| `prompts/skills/micro-task-decomposition.md` | the plan recipe |
| `prompts/skills/write-tests.md` | tests, spec-aware |
| `prompts/skills/verify-against-spec.md` | the verification recipe |
| `prompts/roles/auditor.md` | the audit posture |

In planning mode REI can write to `.rei/specs/`, `.rei/plans/` and `docs/` — enough to persist the
flow's artifacts — and nothing else. Source changes require agent mode. The scope is enforced when a
write executes (`src/agent-mode/tools-loop/write-scope.ts`), not by hiding the tools, so a refusal
tells the model where it *may* write.

## Commands

| Command | Step |
|---|---|
| `/spec <task>` | write the contract |
| `/savespec <name>` · `/loadspec <name>` | persist / bring one back |
| `/role auditor` · `/role off` | audit before implementing |
| `/decompose` | spec → traceable plan |
| `/saveplan <name>` · `/loadplan <name>` | persist / bring one back |
| `/runplan [stage <n>]` | execute all, or one stage |
| `/think <level>` | change the reasoning budget mid-session |
