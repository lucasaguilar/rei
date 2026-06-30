---
name: write-spec
description: Write a lightweight spec (goal, in/out of scope, testable acceptance criteria) BEFORE planning, so the plan and code cannot drift beyond what was asked
modes: planning
---

# Skill: Write a spec before planning

Use this FIRST — before decomposing anything into a plan — when a task is non-trivial or its scope is
fuzzy. A spec is the **source of truth**: it pins down WHAT is wanted and how we'll know it's done, so
the plan (and the code) can't quietly grow beyond the request. This is the upstream half of
spec-driven development; the downstream half is the `micro-task-decomposition` skill.

## Why it matters

Models over-interpret vague prompts and inflate scope — e.g. "show the config values" silently
becomes "build an editable, localStorage-persisted config editor with caching". An explicit
**Out of scope** list plus **testable acceptance criteria** are the guardrails that stop that drift.

## Ground it first

Read the relevant files (`read_files`) and explore (`run_command`) BEFORE writing the spec,
exactly like planning. The spec must reflect the real codebase, not assumptions.

## Spec format — emit exactly these sections

```
# Spec: <short title>

## Goal
One sentence: the outcome the user wants, in their words. No solution detail.

## In scope
- Concrete bullets of exactly what this work includes.

## Out of scope (non-goals)
- Concrete bullets of what this work explicitly does NOT include.

## Acceptance criteria
1. <observable, independently-checkable statement>
2. ...

## Constraints
- Tech/patterns/performance/security limits any implementation must respect.

## Open questions
- Anything ambiguous to confirm BEFORE planning. If none, write "None".
```

## Section rules

- **Goal** — the user's intended outcome in one sentence. No "how".
- **In scope** — be concrete; name the files/areas that will change if you can.
- **Out of scope** — the **most important section**. List every tempting adjacent feature the prompt
  does NOT ask for (editing, persistence, new endpoints, auth, caching, refactors). If the prompt says
  "display", write "no editing, no persistence". When unsure whether something belongs, put it here
  and raise an Open question.
- **Acceptance criteria** — numbered, each one a thing you could verify true/false after the work.
  Prefer "Given/When/Then" or "The X shows Y". Reject vague criteria like "works well". These are what
  the plan's final verification stages must check.
- **Constraints** — e.g. "Angular standalone + OnPush", "no secrets in client config".
- **Open questions** — surface ambiguity instead of guessing.

## Hard rules

- Stay faithful to the prompt. If the user said "display", do NOT add edit/save/persist to scope.
- Keep it short — a spec is a contract, not an essay.
- Do NOT write implementation steps here — that is the plan's job.
- After the user confirms the spec, decompose it with the `micro-task-decomposition` skill.
