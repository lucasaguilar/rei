# REI Launch Plan — from "works on my machine" to "someone else runs it"

Status: **proposed**, 2026-09-09.

The goal is NOT more features. It is to move REI from a private repo with one user to a public
repo with a second one. Everything below is scoped by that.

## Where we actually are

| | |
|---|---|
| Source | 31,111 lines / 215 files (excluding tests) |
| Tests | 1,153 passing / 153 files · tsc clean · lint clean · CI green |
| Guardrails | 400-line file cap enforced by a failing test |
| Repo | **private** — CI badge and `curl \| bash` installer both 404 |
| Demo | none |
| Users | one, on two machines |

The discipline is better than most published projects. The exposure is lower than almost all of
them. Both are cured by the same act: publishing.

## The one real engineering risk

Four times in a single session (2026-09) the same defect class turned up: **configuration that is
declared, parsed, and then never enforced.**

| Config | Declared | Enforced |
|---|---|---|
| `SENSITIVE_FILE_NAMES` | yes | no → fixed |
| `modelFeedback` | yes | no → fixed |
| `DEFAULT_FILE_MODIFY_POLICY` | yes | no → fixed |
| Role `writeGlob` / `preferredModel` | yes | no → fixed |
| Role permissions inside sub-agents | yes | no → fixed |

Four is not bad luck, it is a pattern: features get built to the parse layer and stop there. Each
one reads as a working feature — the field is in the file, the docs describe it, nothing errors —
which is exactly why they survive. A user trusting `writeGlob` to keep an agent out of their source
is trusting a comment.

This is the thing most likely to produce a bad first issue, so it is the only engineering item that
outranks publishing.

---

## Phase 0 — Unblock (🧑 you, ~10 min)

Nothing else can be tested until this happens.

1. Make `github.com/lucasaguilar/rei` public.
2. Verify the CI badge resolves in the README.
3. Verify `curl … | bash` installs from a clean directory.

**Done when:** a stranger can read the README and install REI.

## Phase 1 — Legible in thirty seconds (🧑 + 🤖)

A local coding agent with no demo does not convert. Neither does one whose best card is buried.

1. **🧑 Record the demo GIF.** Not a chat. Show the loop nobody else shows: an edit, the real
   compiler rejecting it, the agent reading the error and fixing it. That is the thesis in
   fifteen seconds.
2. **🤖 Promote "declared permissions are enforced" in the README.** It is currently a
   configuration detail. It is the sharpest differentiator REI has — a role declares `writeGlob`
   and REI *gates the write*, in the main loop and inside sub-agents. Most agents put the
   restriction in the prompt and hope.
3. **🤖 Document the two role invocations.** `/role X` (shared context) vs `/X <task>` (isolated).
   The distinction confused its own author; it will confuse everyone.

**Done when:** the README's first screen answers "what is this and why not aider".

## Phase 2 — Survive first contact (🤖, then 🧑)

1. **🤖 Audit every declared config for enforcement.** For each env var in `docs/config-reference.md`
   and each field in `rei.config.json` / role frontmatter: find where it is parsed, then find where
   it is *acted on*. Report the gaps; fix or delete each one. Deleting is a valid outcome — a
   removed field is honest, an ignored one is not.
2. **🤖 Turn the pattern into a guardrail.** A meta-test in the shape of the existing file-size cap:
   every documented config key must be referenced somewhere outside its own parser. Crude, and it
   would have caught four of the five above.
3. **🧑 Smoke-test the cloud path.** Untested for a while, by your own account, and it needs your
   keys. One turn per provider is enough.
4. **🧑 Install on a machine that has never run REI.** Not the second machine — a clean one.

**Done when:** no config in the docs is a lie, and a fresh install completes a turn.

## Phase 3 — One user who is not you (🧑)

One person. Their machine, their repo, their model. Watch where they get stuck without helping.

This is worth more than the next three features, and it is the only item here that cannot be
front-loaded. Everything above exists to make this possible.

**Done when:** someone else has filed the first issue.

---

## Explicitly not doing

Sub-agents, roles, SDD, `/trace`, scaffolding — that is already more surface than one person can
maintain with nobody using it. The backlog below stays parked until Phase 3 produces demand:

- `qwen3.8-27b-mtp` and `dflash2` tuning entries
- measuring the `## Scope` section with the bench
- the ~14 files with Spanish comments in `src/` (cosmetic; do it while waiting on a review)
- multi-session, intent router, LSP diagnostics, command queue, image input

A feature added now is a feature nobody asked for, defended forever.
