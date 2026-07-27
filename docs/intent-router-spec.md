# Mini-spec: heuristic intent router + user-elicitation primitive

Status: **SPEC (defined, not implemented).** Goal: a newcomer types what they want in plain
language and REI lands in the right mode — never having to learn `/mode`. Modes stay as the
internal mechanism (system prompt + tool permissions); the router just picks one.

## Principles

1. **Heuristic first, no model.** ~30 lines, pure, deterministic, bilingual (es/en). Reuses the
   exact pattern already shipping in `src/tools/tool-retriever.ts` (`INTENT_KEYWORDS` regex →
   service, cross-lingual). A tiny classifier model is explicitly out of scope for v1 — it adds a
   dependency, latency, and a new silent-failure surface. Revisit only if the heuristic misfires
   often in practice.
2. **The confirm-gate makes a dumb classifier safe.** Escalation to a write-capable mode (`agent`)
   is NEVER silent — it asks. So a misclassification costs one keystroke to decline, not a wrong
   edit. This is what lets us ship a cheap heuristic without a model.
3. **Asymmetric safety** (the whole design rests on this):

   | Transition | Writes disk? | Policy |
   |---|---|---|
   | ask ↔ planning | no | auto, silent |
   | agent → ask/planning | no (drops privileges) | auto, silent |
   | → **agent** | **yes** | **confirm via elicitation, never silent** |

## Router contract

```ts
type SessionMode = "ask" | "planning" | "agent";
type RouteResult =
  | { kind: "switch"; mode: SessionMode }          // safe: apply silently
  | { kind: "confirm"; suggested: "agent"; reason: string }  // escalation: ask first
  | { kind: "stay" };                               // no signal → keep current mode

function routeIntent(text: string, current: SessionMode): RouteResult;
```

Runs on each user message **unless** auto-mode is off or a manual `/mode` pin is active (see
Config). Pure function → fully unit-testable with a table of inputs.

## Heuristic patterns (bilingual)

Word-boundary, case-insensitive, accent-tolerant. Match against the **leading intent** of the
message (first ~8 tokens weigh more; a trailing edit verb inside a question shouldn't flip it).

### Edit intent → `agent` (escalation → confirm)
| Lang | Triggers (imperative edit verbs) |
|---|---|
| es | `cambi(á|a|ar)`, `agreg(á|a|ar)`, `añad(í|e|ir)`, `arregl(á|a|ar)`, `corrig(e|í)`, `renombr(á|a|ar)`, `refactoriz(á|a|ar)`, `cre(á|a|ar)`, `borr(á|a|ar)`, `elimin(á|a|ar)`, `quit(á|a|ar)`, `implement(á|a|ar)`, `actualiz(á|a|ar)`, `reemplaz(á|a|ar)`, `mov(é|e|er)`, `escrib(í|e|ir)` |
| en | `change`, `add`, `fix`, `rename`, `refactor`, `create`, `delete`, `remove`, `implement`, `update`, `replace`, `move`, `write`, `make`, `rewrite`, `edit`, `wire up`, `hook up` |

### Planning intent → `planning` (safe, silent)
| Lang | Triggers |
|---|---|
| es | `diseñ(á|a|ar)`, `planific(á|a|ar)`, `plane(á|a|ar)`, `arquitectura`, `enfoque`, `convien(e)`, `deberíamos`, `estrategia`, `spec`, `especific(á|ar)`, `cómo encararías` |
| en | `design`, `plan`, `architect`, `approach`, `should we`, `strategy`, `spec`, `outline`, `propose`, `how would you structure` |

### Question intent → `ask` (safe, silent; also the default)
| Lang | Triggers |
|---|---|
| es | leading `qué`, `por qué`, `cómo`, `dónde`, `cuándo`, `cuál`, `explic(á|a)`, `mostr(á|ame)`, `entend(és|er)`, `sab(és|er)`, `es`, `está`, or ends with `?` |
| en | leading `what`, `why`, `how`, `where`, `when`, `which`, `explain`, `show`, `does`, `is`, `are`, `tell me`, or ends with `?` |

## Disambiguation rules (the overlaps that matter)

Resolved in this order:

1. **Question wrapper beats an inner edit verb.** `explain how to add a button` / `¿cómo agrego
   un botón?` → **ask** (leading question word + no imperative subject). Rule: if the message
   *leads* with a question/explain token, classify as ask even if an edit verb appears later.
2. **Edit verb in imperative position → escalation.** `add a button` / `agregá un botón` → confirm
   agent. `can you change X?` / `¿podés cambiar X?` → still confirm agent (it *is* an edit request;
   the confirm gate absorbs the politeness/question framing at one keystroke cost).
3. **Planning cue present → planning**, unless an edit verb is *also* imperative-leading, in which
   case offer planning as a third option in the confirm (`Sí editá · No, solo explicá · Primero
   planificá`).
4. **No signal → `stay`** (keep current mode; if session just started, that's `ask`).

Tie-break summary: `planning-cue > question-wrapper > edit-verb > default(ask)`, with edit-verb
always routed through confirm rather than a silent switch.

## Elicitation primitive (frontend-agnostic)

REI has no native "ask the user mid-turn" capability today (`@clack/prompts` lives only in the
launch wizard, not the runtime). This adds one — but as an **abstraction**, because REI runs both
as a CLI and as a server (Continue.dev). Do NOT bury `@clack` calls in core.

```ts
interface Elicitation {
  id: string;
  kind: "confirm" | "select";
  message: string;
  options?: { value: string; label: string }[];  // for "select"
  default: string;                                 // used in non-interactive contexts
}
interface ElicitationResponse { id: string; value: string; }

// Core requests a decision and awaits it; the active frontend renders + resolves.
type ElicitFn = (e: Elicitation) => Promise<ElicitationResponse>;
```

- **CLI frontend** renders with `@clack/prompts` (`confirm` / `select`).
- **Server frontend** sends the `Elicitation` over its protocol and waits for the response.
- **Non-interactive** (`rei plan "…"`, one-shot, no TTY) → resolve to `default`. The escalation's
  default is the SAFE choice: **decline → stay in ask/planning** (never auto-edit unattended).

The mode-escalation confirm is the first consumer; it's reused later for disambiguation
("found 3 `Button` components — which one?") and dangerous-action confirms.

## `ask_user` design: tool, gates, and when to ask

Separate **capability** from **affordance**. The capability (asking mid-turn) is the `ElicitFn`
primitive above — plumbing, not a skill or a tool. The affordance is *how the question gets
triggered*, and there are **two triggers**, not one:

### Skill vs tool → a TOOL, not a skill
Asking the user is a single, stable, atomic action with structured args — the tool-registration seam
(like `web_search`), not the data-driven skills catalog. Match the seam to cardinality: many
procedures = skills; one stable capability = a tool. A skill is the wrong shape anyway — it's just
markdown injected into context and **cannot render a `@clack` prompt**; only a tool handler can call
`ElicitFn`. This is also the frontier-native pattern (the model's `AskUserQuestion`).

### The dual trigger (this is the "when")
| Trigger | Who decides | Example | Depends on the model? |
|---|---|---|---|
| **Model-triggered** — the `ask_user` tool | the **model** calls it when unsure | "is this a login or a signup form?" before coding | yes |
| **REI-triggered** — deterministic gates | REI in the loop, regardless of the model | "escalate to agent and edit? [Y/N]" · confirm a dangerous action | **no** |

Both call the same `ElicitFn`. The insight: a weak local model can't be trusted to *remember* to ask
(the same reason REI has produce-or-bail and other guards). So `ask_user` is the **bonus** (clarify
before wrong work) and the deterministic gates are the **guarantee** (safety never depends on the
model choosing to ask, nor on its tool-calling reliability).

### Why this pays off in REI specifically
On local models the #1 cost is turns burned on wrong assumptions (the observed 29-command loop).
Asking cheaply now = far less wrong work later — the verifier-in-loop thesis applied to *requirements*,
not just code. That's why it "sums": it's loop-efficiency for weak models, not UX polish.

### Teaching the model *when* to call `ask_user`
- **Tool description (tight, with a boundary):** "Call when a decision is genuinely the user's, or the
  request is ambiguous — ask BEFORE doing wrong work. Do NOT use it for things you can determine by
  reading the repo." Include 1–2 examples.
- **One system-prompt line** reinforcing it.
- **The deterministic gates** as the backstop for whatever the model still doesn't ask.
- Available in ask/planning/agent (it's read-only/safe everywhere); cannot escalate privileges.

## Config

| Var | What | Default |
|---|---|---|
| `REI_AUTO_MODE` | enable heuristic routing | `true` |
| `REI_AUTO_MODE_CONFIRM_AGENT` | require confirm before entering agent | `true` (do not disable lightly) |
| manual `/mode <x>` | pins the mode for the session, suppresses auto-routing | — |
| `/mode auto` | re-enable auto-routing after a manual pin | — |

Power-user path is untouched: explicit `/mode` still works and, once used, pins until `/mode auto`.

## Implementation sketch

- `src/chat/intent-router.ts` — pure `routeIntent()` + the pattern tables. ~30–50 lines.
- `src/chat/intent-router.test.ts` — input→RouteResult table (es/en, each overlap rule).
- `src/chat/elicitation.ts` — the `Elicitation`/`ElicitFn` types + a CLI `@clack` implementation
  and a null/default implementation for non-interactive.
- Wire in the chat turn entry: before dispatching a user message, call `routeIntent`; on
  `switch` apply silently, on `confirm` call `elicit`, on `stay` do nothing.
- No changes to the tool loop, providers, or mode mechanics themselves.

## Why this simplifies (and the risk to watch)

For the **user**: modes stop being a concept to learn — they type intent, REI routes, and asks
only when it's about to touch disk. Control is intact at the one point that matters.

For the **code**: keep it to *heuristic + confirm-on-escalate* in v1. The temptation to add the
tiny model and full multi-frontend elicitation at once is where "simplify for the user" becomes
"complicate the code." Ship the 30-line router + the confirm gate first; everything else is later.

## Design reference: how a frontier agent does this (and why it unifies the two features)

A frontier coding agent (e.g. Claude Code) has **no modes**: one loop, all tools always available,
the model self-selects read/plan/edit per step. Safety comes from (1) the harness gating write/exec
actions, (2) a **question tool** the model calls when a decision is genuinely the user's, (3)
confirming before hard-to-reverse actions. REI's modes are an *external scaffold* that rebuilds, for
local models, what a frontier model does internally.

The consequence for this spec: the two "improvements" the user asked for are **one primitive with two
consumers**, so we build once and get both:

| | Trigger | Consumer | Risk |
|---|---|---|---|
| Mode escalation confirm | REI (router) decides to ask | intent-router `→agent` gate | safety-critical |
| Clarifying questions | the **model** decides to ask | an `ask_user` tool (spec/doubt resolution) | safe (just asks) |

Both resolve through the same `ElicitFn`. `ask_user` (model-triggered) is REI's equivalent of the
frontier `AskUserQuestion` tool — the highest-leverage half, because it lets the model resolve
ambiguity *before* doing wrong work (directly serves the verifier-in-loop thesis).

## Implementation plan (phased, each phase independently shippable)

Ordering principle: build the shared primitive first, then the safe model-facing tool (zero behavior
change to existing flows), and put the only risky part — silent auto-switching — LAST, on a proven
primitive. Every phase is small, pure where possible, and feature-flagged.

### Phase 0 — Elicitation primitive (the foundation)
- **Files:** `src/chat/elicitation.ts` — the `Elicitation` / `ElicitationResponse` / `ElicitFn`
  types (from §"Elicitation primitive"); a CLI implementation using `@clack/prompts`
  (`confirm`/`select`); a non-interactive implementation that resolves to `default`.
- **Wire:** thread one `ElicitFn` into the chat session context (CLI passes the `@clack` impl;
  server passes its protocol impl; one-shot/`rei plan`/no-TTY passes the default impl).
- **Safety:** the non-interactive default is always the SAFE choice (decline escalation / no edit).
- **Tests:** `elicitation.test.ts` — non-interactive resolves to default; select returns chosen
  value; unknown/cancel → default.
- **Exit criteria:** a callable `elicit(e)` exists in a turn, renders in CLI, no-ops safely headless.
  No user-visible behavior yet.

#### Pluggability — Phase 0/1 attach the way a tool does, not by rewiring core
REI already has two extension seams; Phase 0/1 use the second, so nothing in core changes:
1. **Data-driven (skills):** drop a `.md` → capability, exposed via the single `use_skill` catalog.
2. **Injected callback:** `DispatchContext` (dispatch-tool-calls.ts) already carries
   `emitStatus: (msg) => void` — a frontend-provided callback the core calls blind. **`ElicitFn` is
   its twin** (`elicit: (e) => Promise<ElicitationResponse>`): add it as a sibling field. The
   injection channel already exists — no new param threaded through the call chain.

`ask_user` follows the exact additive recipe of `web_search`/`weather`: (1) define `ASK_USER_TOOL`
in `contracts/tool-definitions.ts` gated by `toolsForMode`; (2) one line in `tool-selection.ts`
`buildTools()`; (3) a `handleAskUser` handler file; (4) one `case "ask_user"` in the dispatch
switch; (5) one `elicit` field on `DispatchContext`. Make `elicit` **optional with the safe
non-interactive default** → existing callers that don't pass it are unaffected (backward-compatible,
cannot break current flows). Do NOT make `ask_user` data-driven like skills — it's a single stable
tool (one registration), not a family (catalog); match the seam to the cardinality. `elicit` is born
at the session level (where `emitStatus` originates) so Phase 3's router can reach it too; Phase 0/1
only need it wired into `DispatchContext`.

### Phase 1 — `ask_user` tool (model-triggered elicitation) — the high-value, low-risk half
- **Files:** add an `ask_user` tool definition + handler that calls `ElicitFn`. Lives with the other
  builtin tool handlers (`src/agent-mode/tools-loop/builtin-handlers.ts` pattern).
- **Behavior:** the model can call `ask_user({ question, options? })` mid-turn to resolve a spec
  ambiguity or a doubt; the answer comes back as a tool result and the model continues. In
  non-interactive contexts it returns the default so the loop never hangs.
- **Scope:** offer it in ask/planning (and agent) — it's read-only/safe everywhere.
- **Safety:** purely additive; asks, never acts. Cannot escalate privileges.
- **Tests:** tool schema; handler forwards to `ElicitFn`; headless returns default.
- **Exit criteria:** REI can pause and ask a real question about a spec — the frontier-style
  clarify-before-work capability — with modes untouched.

### Phase 2 — heuristic router (pure, no model)
- **Files:** `src/chat/intent-router.ts` (`routeIntent` + the bilingual pattern tables from above);
  `intent-router.test.ts` (input→RouteResult table covering each disambiguation rule).
- **Scope:** pure function only — NOT wired into the turn yet. Prove the classifier in isolation.
- **Exit criteria:** table tests green for es/en, including the overlap cases (`can you change X?`,
  `explain how to add…`, planning-cue + edit-verb).

### Phase 3 — wire the router into the turn (the auto-switch, behind a flag)
- **Wire:** at the chat turn entry, before dispatch, call `routeIntent(text, current)`:
  `switch` → apply silently; `confirm` → call `elicit` (reusing Phase 0), enter agent only on yes;
  `stay` → nothing. Respect manual `/mode` pin; add `/mode auto`.
- **Config:** `REI_AUTO_MODE` (default on), `REI_AUTO_MODE_CONFIRM_AGENT` (default on). Ship with a
  short first-run note so the behavior isn't surprising.
- **Safety:** `→agent` NEVER silent; headless resolves the confirm to decline (stay in ask/planning).
- **Exit criteria:** a newcomer types intent in plain language and lands in the right mode; `/mode`
  becomes almost never necessary; power users keep explicit control.

### Phase 4 — later (explicitly out of v1)
Tiny classifier model (only if Phase 2 heuristics misfire in practice); richer elicitation kinds;
telemetry on router accuracy; and — the future vision — a wizard that spins up different **agent
types per job** and hot-swaps them, layered on the same elicitation + routing foundation.

### Sequencing summary
`Phase 0 (primitive)` → `Phase 1 (ask_user: value, no risk)` → `Phase 2 (router: pure, no wiring)`
→ `Phase 3 (auto-switch: the only risky step, on proven pieces, flagged)`. Stop after any phase and
REI is still coherent and shippable.
