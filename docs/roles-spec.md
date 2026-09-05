# Mini-spec: data-driven roles (auditor, security, finance, …)

Status: **SPEC (defined, not implemented).**

## Goal & principle

Give REI **postures/roles** (an adversarial code auditor, a security reviewer, a finance analyst…)
WITHOUT hardcoding a new mode per role. Today `SessionMode = "ask" | "planning" | "agent"` is a closed
enum and `toolsForMode` is hardcoded — adding `/mode auditor` there, then `security`, `finance`,
`legal`… doesn't scale (it's the Pi anti-pattern we rejected: hardcode vs. extensible).

**Principle (already validated this session):** *many things → data-driven; one stable thing → a mode/
tool.* Roles are MANY → **data-driven markdown**, exactly like the existing skills (`prompts/skills/*.md`
+ `skill-loader`). A role = a markdown file. **Adding a role = dropping a `.md`, zero code.**

A role is NOT a 4th core mode. It's a **posture layered on an existing permission profile** (auditor =
read-only, i.e. the `ask`/`planning` profile + a scoped write for its review). So no new tool-permission
profile is needed for read-only roles.

## The role markdown contract (extends the skill frontmatter)

`prompts/roles/<name>.md` — reuses the skill frontmatter parser (`name`/`description`), plus role fields:

```markdown
---
name: auditor
description: Adversarial Lead-Architect review of a plan/spec — finds blind spots before implementation
baseMode: planning          # which permission profile it borrows (ask|planning|agent). Default: planning
writeGlob: "*.review.md"    # the ONLY files it may write (read-only otherwise). Optional.
preferredModel: gemma-4-26b-a4b   # optional hint (Phase 2) — a DIFFERENT model than the builder
---

<the posture / system-prompt body: adversarial stance, mandatory criteria, required output structure,
 and — critically — GROUNDING rules (every finding must cite a line/section of the source doc).>
```

The **body IS the system prompt** injected when the role is active (via `buildSystemMessage`). It carries
the posture + criteria + output format — none of it hardcoded in TS, so `security.md`/`finance.md`/
`legal.md` each bring their own criteria.

## Activation

- `/role <name>` — activate the role (loads `roles/<name>.md`, applies its baseMode profile + injects
  its posture). `/role off` / `/role clear` → back to the plain mode.
- `/mode <name>` — sugar: if `<name>` isn't a core mode but a role file exists, load the role. So
  `/mode auditor` works as the user expects, but under the hood it's a role, not a 4th mode.
- `/roles` — list available roles (like `/docs`, `/session list`).

## Non-negotiables in the role body (learned this session)

The auditor.md body (and the template for other roles) MUST encode:
1. **Kill sycophancy** — no validating/praising by default; assume the plan fails until proven otherwise.
2. **Grounding** — EVERY finding cites the line/section of the source doc (like ask-document cites pages).
   Without this a local model hallucinates critiques. This is the #1 auditor failure mode.
3. **Read-only on the subject** — critiques the plan, never edits it; writes only its `*.review.md`.
   Separation of powers: builder writes, auditor critiques, HUMAN decides (Human-in-the-Loop).
4. **Structured output** — executive summary (Approved-with-notes / Needs-critical-fixes / Unviable) +
   risk table (`Component | Risk | Severity | Mitigation`) + blind-spots/open-questions list.

## The flow it enables

```
ask → write-spec → micro-task-decomposition (plan.md)
   → /role auditor  (reads plan.md, red-teams)  → plan.review.md
   → adjust the plan per the review
   → /runplan (implement) → verify
```
Chainable: architecture auditor → security auditor → each its own `*.review.md`.

## The synthesis (why this is the payoff of the whole session)

**Audit with a DIFFERENT model than the builder** = bias diversity, not just variety. A model's blind
spots correlate with its training; a second model catches what the first can't (self-review is weak).
This lands directly on what we just built:
```
Terminal 1:  rei -s builder   → planning with qwen3.6-27b → plan.md
Terminal 2:  rei -s auditor   → /role auditor with gemma-4 → plan.review.md
```
multi-session + per-model on-demand + data-driven roles + one repo → real red teaming. See
[[rei-multi-session]], [[rei-per-model-config]], [[rei-verifier-in-loop-thesis]], [[rei-sdd-skills-layer]].

## Implementation phases

1. **Phase 1 — role loader + `/role` + `auditor.md` (read-only, current model).** A `role-loader.ts`
   (reuse the skill frontmatter parser) reads `roles/<name>.md`; `/role <name>` sets an active role on
   the session; `buildSystemMessage` prepends the role body + applies `baseMode` (default planning →
   read-only). Ship `prompts/roles/auditor.md` with the non-negotiables above. `/mode <name>` sugar +
   `/roles` list. — *this alone lets you TRY the auditor: `/role auditor`, ask it to review a plan.md.*
2. **Phase 2 — preferredModel + write scope.** Honor `preferredModel` (integrates with per-model config
   / on-demand), and enforce `writeGlob` so the auditor can persist `plan.review.md` but touch nothing
   else. — *the "different model per role" payoff + safe review persistence.*
3. **Phase 3 — grounding assist + more roles.** Optional: feed the target doc with line/section markers
   so citations are exact (like the ask-document chunker). Add `security.md`, `finance.md`, `legal.md`.

Stop after Phase 1 and you can already run the adversarial auditor.

## Files to touch (high level)
- NEW `src/skills/role-loader.ts` (or extend `skill-loader.ts`) — parse `roles/*.md`.
- NEW `prompts/roles/auditor.md` — the first role.
- `src/prompts/prompt-builder.ts` (`buildSystemMessage`) — prepend the active role's posture.
- `src/chat/commands/` + `registry.ts` — `/role`, `/roles` handlers (the recipe from DEVELOPER-GUIDE.md).
- `src/chat/types.ts` — a session-level `activeRole?` (not a new SessionMode value).
- Phase 2: per-model resolution honors `preferredModel`; a write-guard checks `writeGlob`.
