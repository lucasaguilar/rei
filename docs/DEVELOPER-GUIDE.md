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

- **[Add a slash command](#recipe-add-a-slash-command)** ✅ _(the model recipe below — the template all others follow)_
- Add a tool the model can call — _TBD_
- Modify the agent loop / add a guard — _TBD_
- Add a model provider — _TBD_
- Add a skill — _TBD_
- Add per-model config (sampling / context window) — _TBD_ (see [`model-config-spec.md`](./model-config-spec.md))
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

## The three extension seams

REI extends through **three** seams — pick by cardinality:

| Seam | For | Example |
|---|---|---|
| **Command registry** | user-typed `/commands` | `/tree`, `/doctor` |
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
