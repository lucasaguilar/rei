# REI — Developer Guide

> **The task-oriented entry point for extending REI.** Want to add a command, a tool, a provider, or
> touch the agent loop? Start here: each recipe gives the exact files, steps, and pattern, and links to
> the deep doc when you need more.
>
> This guide is the *index + how-to*; it does **not** duplicate the deep docs — it points to them.

## How to use this guide

1. Find your task in **[I want to…](#i-want-to)** below.
2. Follow the recipe (files → steps → pattern → verify).
3. For the "why" / deep dive, follow the linked doc.

**You don't have to scroll:** every recipe names the files it touches, so searching this page for a
file name (`registry.ts`, `provider-factory.ts`) lands you in the right one.

---

## Map of REI (30 seconds)

```
rei (CLI)                         server.ts (HTTP / IDE)
   └─ src/cli/run-chat.ts            └─ src/server/chat-handler.ts
        │  input loop, commands, TUI
        ▼
   Agent  (src/core/agent.ts)  ── one prompt = one streamTurn
        │  builds context (RAG + repo-map + file-tree), picks the mode's model
        ▼
   Native tool loop  (src/agent-mode/generator-tools.ts → executeAgentTurnWithTools)
        │  model calls tools in a loop until it answers (guards: produce-or-bail, blocked-repeat)
        ▼
   Tool dispatch  (src/agent-mode/tools-loop/dispatch-tool-calls.ts)
        │  routes each tool call → its handler (read_files, edit_file, run_command, ask_user, delegate…)
        ▼
   Provider  (src/providers/*)  ── sends the request to the model (LM Studio, Ollama, cloud…)
```

**The 6 things you'll extend, and where they live:**

| Thing | Where | Recipe |
|---|---|---|
| **Slash command** (`/tree`, `/doctor`) | `src/chat/commands/` + `registry.ts` | [↓ Add a slash command](#recipe-add-a-slash-command) |
| **Tool the model calls** (`ask_user`, `delegate`) | `contracts/tool-definitions.ts` + `tools-loop/` | _(recipe TBD)_ |
| **Agent loop / a guard** | `agent-mode/generator-tools.ts` + `tools-loop/` | _(recipe TBD)_ |
| **Provider** (a new backend) | `src/providers/` + `provider-factory.ts` | _(recipe TBD)_ |
| **Skill** (a markdown recipe) | `prompts/skills/*.md` | _(recipe TBD)_ |
| **Per-model config** (sampling, window) | `rei.config.json` + `config/model-tuning.ts` | _(recipe TBD)_ |

Modes (`ask` / `planning` / `agent`) = a system prompt + a tool-permission profile (`toolsForMode`).
Deep architecture: [`architecture-map.md`](./architecture-map.md) · agent loop: [`agent-loop.md`](./agent-loop.md).

---

## I want to…

- **[Add a slash command](#recipe-add-a-slash-command)** — for something the *user* types
- **[Add a tool the model can call](#recipe-add-a-tool-the-model-can-call)** — for something the *model* invokes
- **[Add a model provider](#recipe-add-a-model-provider)** — for a new backend
- Modify the agent loop / add a guard — _no recipe yet; start from [`agent-loop.md`](./agent-loop.md)_
- Add a skill — _no recipe yet; the catalog is `prompts/skills/*.md`, loaded by `use_skill`_
- Add per-model config (sampling / context window) — no code needed: an entry in `rei.config.json`, see [`model-config-spec.md`](./model-config-spec.md)
- Understand the extension seams — [↓ below](#the-three-extension-seams)

---

## Recipe: Add a slash command

**Goal:** a new `/foo` command the user can type in the CLI.

**Pattern:** REI dispatches commands through a **registry of small `CommandHandler`s** (an incremental
migration out of one big if/else — see [`refactor-plan.md`](./refactor-plan.md)). You add a handler and
register it. Nothing else changes.

### The 3 files you touch

| Step | File | What you add |
|---|---|---|
| 1 | `src/chat/commands/<foo>-commands.ts` | a `CommandHandler` (`match` + `run`) — **new file** |
| 2 | `src/chat/commands/registry.ts` | import it + add to `COMMAND_HANDLERS` |
| 3 | `src/cli/constants/chat.constants.ts` | add to `COMMANDS` (for `/help` + Tab-complete) |

### Step 1 — the handler

A `CommandHandler` (see `src/chat/commands/command-handler.ts`) is `{ match, run }`. `run` receives a
`CommandContext` (`command`, `session`, `workspacePath`, `provider`, `onStatus`) and returns a
`CommandResult` (`{ success, response, recordInSession? }`).

```ts
// src/chat/commands/foo-commands.ts
import type { CommandHandler, CommandResult } from "./command-handler.js";

export const fooCommands: CommandHandler = {
  match: (c) => c === "/foo" || c.startsWith("/foo "),
  run: ({ command, session }): CommandResult => ({
    success: true,
    // recordInSession:false → shown in the terminal but NOT added to the model context (zero tokens).
    // Use `true` only when the output should become part of the conversation (e.g. /ask-document).
    recordInSession: false,
    response: `[REI] foo ran on a session with ${session.messages.length} messages.`,
  }),
};
```

**Rules of thumb**
- `match` must be **exact** for what it owns — return `false` for anything it doesn't fully handle so it
  falls through to the next handler / the legacy dispatcher.
- Default to `recordInSession: false` (terminal-only). Only record when the output must be part of the
  conversation history.
- `run` may be `async`. It gets `provider` + `workspacePath` for real work (see `session-commands.ts`).
- Need to ask the user mid-command? The `provider`/session already flow; for grounded flows see how
  `document-commands.ts` sets per-model tuning before calling out.

### Step 2 — register it

```ts
// src/chat/commands/registry.ts
import { fooCommands } from "./foo-commands.js";
// …
const COMMAND_HANDLERS = [
  sessionCommands,
  // …
  fooCommands,   // ← add
];
```
`dispatchCommand` runs the first handler whose `match` returns true; `null` when none matches (→ legacy
fallback). It's wired into `menu-command-processor.ts` → so nothing else to hook up.

### Step 3 — make it discoverable

```ts
// src/cli/constants/chat.constants.ts → COMMANDS array
{ command: "/foo", description: "do the foo thing" },
```
This drives `/help` and Tab-completion. (Purely cosmetic — the command works without it, but always add it.)

### Verify

```bash
npm run build && npx vitest run src/chat
```
Add a unit test next to the handler (pure `match`/`run`, no I/O) — see `tree-commands.test.ts` for the
pattern (test `match` true/false + the `response`).

### Reference implementation

`/tree` is a clean, real example: `src/chat/commands/tree-commands.ts` (a pure `summarizeTurns` +
`renderSessionTree` + the handler). Copy its shape.

---

## Recipe: Add a tool the model can call

A tool is a capability the **model** invokes, not the user. Four files, in the order the call
travels: definition → the per-turn tool list → dispatch → handler.

### The 4 files you touch

| Step | File | What you add |
|---|---|---|
| 1 | `src/contracts/tool-definitions.ts` | the `ToolDefinition` (name, description, JSON-schema parameters) |
| 2 | `src/contracts/tool-definitions.ts` | add it to the mode set it belongs to (`AGENT_TOOLS` / `PLANNING_TOOLS` / `READONLY_TOOLS`), **or** export it standalone and push it in `buildTools` |
| 3 | `src/agent-mode/tools-loop/dispatch-tool-calls.ts` | a `case "<name>":` that reads `args` and calls your handler |
| 4 | `src/agent-mode/tools-loop/builtin-handlers.ts` | the handler itself — the only place that does I/O |

### Step 1 — define it

The description is not documentation: it is the whole instruction the model gets about when to
reach for this. Say **when to use it and when not to**; a tool described as "searches the web" is
called for things that are in the repo.

### Step 2 — decide who gets it

`toolsForMode()` hands out three sets. Agent mode gets the writing tools; `ask` and `planning` get
read-only ones — a tool that edits must never appear there. For a tool that is not part of a mode
set (conditional, opt-in), export it and push it inside `buildTools()` in
`src/agent-mode/tools-loop/tool-selection.ts`, as `delegate` does behind
`REI_SUBAGENT_ENABLED` and `search_tools` does when the tool list gets long.

`buildTools()` runs **every turn**, which is what lets a tool become callable mid-turn after
`search_tools` finds it.

### Step 3 — dispatch

Add the `case` next to `web_search` and `ask_user`. Read the arguments defensively
(`(args.query as string) ?? ""`): they come from a model, and a local one will send a missing or
misspelled field eventually.

### Step 4 — the handler

Handlers take `{ logger, emitStatus, … }` and return the string the model will read as the result.
`emitStatus` is how the user sees what is happening while it runs. If your tool needs the user to
answer something, take `elicit` — do not read stdin.

### Verify

```bash
npm run build && npx vitest run src/agent-mode
```

Tools cost context: every definition travels in every request, and past ~25 tools REI hides them
behind `search_tools`. A tool that could be a flag on an existing one should be that flag.

### Reference implementation

`ask_user` — definition in `tool-definitions.ts`, case in `dispatch-tool-calls.ts`, handler in
`builtin-handlers.ts`. It is small and shows the `elicit` seam.

---

## Recipe: Add a model provider

Most backends speak the OpenAI-compatible API, and for those a provider is a subclass that sets
five fields. `src/providers/omlx-provider.ts` is the whole thing in 54 lines — read it first.

### The 4 files you touch

| Step | File | What you add |
|---|---|---|
| 1 | `src/providers/<name>-provider.ts` | a class extending `OpenAiCompatibleProvider` — **new file** |
| 2 | `src/providers/provider-factory.ts` | import it, add the name to the union, add a `case` in the factory |
| 3 | `src/providers/provider-factory.ts` | add its env prefix to `PROVIDER_ENV_PREFIX` |
| 4 | `.env.example` + `docs/config-reference.md` | document its variables — a guardrail test fails if you skip this |

### Step 1 — the class

Set `baseUrl`, `apiKey`, `model`, `requestTimeoutMs` and the sampling defaults from
`<PREFIX>_*` environment variables, with a sane default for each. Streaming, tool calling and
reasoning all come from the base class.

Subclass only for what genuinely differs. oMLX exists as its own provider for one reason, stated in
its header: it forwards `chat_template_kwargs` to the chat template and LM Studio does not — a
difference that changes behaviour, not cosmetics. A backend that differs only by URL needs no
class: point `OPENAI_COMPAT_BASE_URL` at it.

### Step 2 and 3 — register it

The prefix in `PROVIDER_ENV_PREFIX` is what makes `<PREFIX>_MODEL`, `_MODEL_ASK`, `_MODEL_AGENT`,
`_MODEL_VISION` and `_MODEL_COMPACTOR` resolve for your provider — all of them, from one entry.
Derive it from the provider name (`omlx` → `OMLX`).

### Step 4 — document it

`src/meta/env-documented.test.ts` fails on any variable the code reads and the reference does not
describe. That is deliberate: a variable nobody can find is a variable that does not exist.

### Verify

```bash
npm run build && npx vitest run src/providers
```

Then, against the real backend: `rei ask "say ok"` and one agent turn that calls a tool — tool
calling is where compat layers diverge, not chat.

### Reference implementation

`src/providers/omlx-provider.ts` (54 lines, one real difference documented) and
`src/providers/openai-compatible-provider.ts` for what you inherit.

---

## The extension seams

Four seams — pick by cardinality:

| Seam | For | Example |
|---|---|---|
| **Command registry** | user-typed `/commands` | `/tree`, `/theme`, `/rules` |
| **Tool registration** | a single stable capability the *model* calls | `ask_user`, `delegate`, `web_search` (define in `tool-definitions.ts` → add to `tool-selection.ts` `buildTools` → `case` in dispatch → handler) |
| **Data-driven (skills)** | *many* reusable procedures | `prompts/skills/*.md` via the `use_skill` catalog |
| **Injected callback** | a frontend capability the core calls blind | `emitStatus`, `elicit` (`ElicitFn`) — added as a field on `DispatchContext` |

Rule: *one stable thing → a tool; many things → the skills catalog; a frontend capability → an injected
callback.* Don't make a single capability a skill (a skill is injected text; it can't render a prompt).

---

## Where things live (file map)

| Area | Path |
|---|---|
| CLI entry / input loop | `src/cli/run-chat.ts`, `src/cli/helpers/`, `src/cli/ui/` |
| Agent orchestration | `src/core/agent.ts` |
| Native tool loop | `src/agent-mode/generator-tools.ts`, `src/agent-mode/tools-loop/` |
| Tool definitions | `src/contracts/tool-definitions.ts` |
| Commands | `src/chat/commands/` (+ `registry.ts`, `menu-command-processor.ts`) |
| Providers | `src/providers/` (+ `provider-factory.ts`) |
| Config resolution | `src/config/model-runtime.ts`, `src/config/model-tuning.ts` |
| Context / RAG | `src/context/`, `src/tools/repo-map-generator.ts` |
| Skills | `src/skills/`, `prompts/skills/` |
| Session / history | `src/chat/session-store.ts`, `src/chat/message-builder.ts` |

---

## Deep docs index

Grouped pointers to the existing deep docs (the "why"/"how it works"):

- **Architecture:** [`architecture-map.md`](./architecture-map.md) · [`agent-loop.md`](./agent-loop.md) · [`prompt-architecture.md`](./prompt-architecture.md) · [`native-path-unification.md`](./native-path-unification.md)
- **Context/RAG:** [`rag-architecture.md`](./rag-architecture.md) · [`how-context-was-generated.md`](./how-context-was-generated.md)
- **Config/models:** [`config-reference.md`](./config-reference.md) · [`model-config-spec.md`](./model-config-spec.md) · [`config-doctor-spec.md`](./config-doctor-spec.md) · [`local-model-configuration.md`](./local-model-configuration.md)
- **Features/specs:** [`intent-router-spec.md`](./intent-router-spec.md) · [`sub-agent-spec.md`](./sub-agent-spec.md) · [`context-drift-spec.md`](./context-drift-spec.md) · [`ocr-architecture.md`](./ocr-architecture.md) · [`docs/features/`](./features/)
- **Onboarding tour:** [`contributor-tour-hop-on-hop-off-style.md`](./contributor-tour-hop-on-hop-off-style.md) — the whole system end to end, no TypeScript expertise assumed.
- **Decisions:** [`docs/adr/`](./adr/)

---

## Maintaining this guide

- **Task-oriented, not exhaustive.** Add a recipe when a real extension task lacks one; link the deep doc
  instead of duplicating it.
- **Anti-rot:** a recipe names concrete files. A CI check verifies every `src/...` path referenced here
  exists (so a moved file fails the build, not a confused developer). _(Guard TBD — see checklist.)_
- **Keep the file paths real.** A recipe is only worth reading if its paths still exist; a stale one
  sends a contributor to a file that moved.
