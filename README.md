```
██████╗ ███████╗██╗
██╔══██╗██╔════╝██║
██████╔╝█████╗  ██║
██╔══██╗██╔══╝  ██║
██║  ██║███████╗██║
╚═╝  ╚═╝╚══════╝╚═╝
```

# REI

[![CI](https://github.com/lucasaguilar/rei/actions/workflows/ci.yml/badge.svg)](https://github.com/lucasaguilar/rei/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**A local-first coding agent that checks its own work against your project's real toolchain.**

Run it against a model on your own machine, or against a cloud one — same tool, same commands. It
reads your repository, proposes changes, applies them, and then runs whatever your project uses to
tell right from wrong: `tsc`, `ngc`, `go build`, `cargo check`, `dotnet build`, `mvn compile`.

**How strong that check is depends on your language**, and REI says which one it ran rather than
implying they are equal:

| Your project | What runs | What it proves |
|---|---|---|
| TypeScript · Angular · Go · Rust · C# · Java | the real compiler | it type-checks and builds |
| Roblox / Luau | `luau-analyze`, `selene`, or `rojo build` | it parses, and analyses if you have the tools |
| JavaScript · Python · PHP | a syntax check over the files | it parses — there is no type checker to run |
| anything unrecognised | nothing | REI says so instead of reporting a pass |

A green result means **"what was applied passes that check"** — never "the task is done". A model
can apply a partial change that compiles perfectly, and REI is built to tell you which of the two
it verified.

---

## Who it's for

- **You run a model on your own machine** — LM Studio, Ollama, MTPLX — and you want an agent built
  for that, not one that treats local as a fallback. Per-mode models, per-model tuning and on-demand
  context all exist because a 30B on your laptop is not a frontier model behind an API.
- **Your code cannot leave the building.** Regulated work, an NDA, a client who says no. Local-first
  is the requirement, not the preference.
- **An agent told you it made a change, and it hadn't.** Or it had, and nothing compiled. REI runs
  your project's real compiler over every edit and reports what it actually found.
- **You are paying per token** for work a machine you already own can do.
- **You want to shape the agent, not accept one.** Roles, skills and prompts are markdown files you
  edit — a reviewer with its own posture and model, a recipe for how your team writes tests. Nothing
  is compiled in.

**Probably not for you if** you have a frontier API budget and no privacy constraint — Claude Code
or Cursor will serve you better, and they should. REI is for the case where those are not on the
table, or where you want the machine to prove its work rather than assert it.

## Start in under a minute

```bash
curl -fsSL https://raw.githubusercontent.com/lucasaguilar/rei/main/install.sh | bash
```

<details>
<summary>Or clone it yourself</summary>

```bash
git clone https://github.com/lucasaguilar/rei && cd rei
npm install && npm run build
./install-rei-cli-local.sh
```
</details>

Then, from any project:

```bash
cd ~/my-project
rei
```

The first run has no configuration, so **REI starts the setup wizard by itself**. It asks for a
provider, takes an API key if you picked a cloud one, or **lists the models your local server
already has** if you picked LM Studio, Ollama or MTPLX. It writes `.rei/.env` in the project and
drops you into the session.

That is the whole setup. To change it later: `rei --config`.

---

## Cloud or local, same tool

| Cloud | Local |
|---|---|
| OpenRouter · Gemini · Groq · Hugging Face | LM Studio · Ollama · MTPLX |

Cloud costs money and needs a key. Local is free, private, and works offline. Pick either in the
wizard; nothing else about REI changes.

REI is an agent, so **the model has to support tool calling.** Most do; some hosted endpoints do
not, and will reject the request outright. The wizard lists what your provider offers, and
`.env.example` names a working default for each.

**And you can give each mode its own model** — which is the point of running locally. A small fast
model to ask questions, the strongest reasoner you have to plan, the most reliable tool-caller to
execute:

```bash
LLM_STUDIO_MODEL_ASK=ornith-1.5-35b        # interactive: favours speed
LLM_STUDIO_MODEL_PLANNING=qwen3.8-27b      # favours reasoning
LLM_STUDIO_MODEL_AGENT=qwen3.8-27b         # favours tool calling
```

### Mix them, and pay for less

`AGENT_MODEL_PROVIDER` puts one mode on a different provider, so a session runs part local and part
cloud:

```bash
MODEL_PROVIDER=llmstudio          # ask + planning — the many, chatty turns, free
AGENT_MODEL_PROVIDER=openrouter   # agent — the edits you want to get right
```

Why that saves anything is not obvious: **exploring is the expensive half.** One measured `ask` turn
here made **22 tool calls for 28,562 input tokens**, because every call re-sends a growing history.
Reading and grepping is where the tokens go, and a local model does it well enough. The choice being
per mode is the point — you stop paying frontier prices for a `grep`.

---

## Three modes

| Mode | What it does | Edits files |
|---|---|---|
| `ask` | Answers questions about the repository | no |
| `planning` | Produces a structured, stage-by-stage plan | no |
| `agent` | Executes: reads, edits, runs commands, verifies | yes |

Switch with `/mode ask`, `/mode planning`, `/mode agent`.

---

## Why it verifies

A model will tell you it made a change. That claim is worth nothing on its own, and it is worth
less with a small local model than with a frontier one.

So REI does not take the model's word. It detects what the project is and runs that project's own
verify command against the edits; a failure goes back to the model with the compiler's own message.

The one rule REI holds to here is that **the check never lies about its own strength.** An
unrecognised project gets no verify command rather than a fake pass — a check that cannot fail is
worse than none, because the agent reads the pass as proof and stops looking. (That was a real bug:
plain JavaScript used to verify with `node --check index.js 2>/dev/null || echo ok`, which printed
"ok" for a project with a syntax error.)

One thing REI is deliberately careful about: **`verified: true` means "what was applied compiles".
It does not mean "the task is done".** A model can apply a partial change that compiles perfectly.
Every report says which of the two it is checking.

---

## Spec-driven development

For anything bigger than a one-file change, REI has a flow that keeps the work tied to what you
actually asked for:

```
/spec add a discount option to the cart total   → writes .rei/specs/<name>.md
/decompose                                      → a plan whose every stage cites a criterion
/trace                                          → do the two still agree?
/runplan                                        → executes, one isolated sub-agent per stage
```

The spec has numbered acceptance criteria. Every plan stage carries a `Satisfies: AC-2` line, and
the last stage judges each criterion **MET / NOT MET / UNVERIFIED, with evidence** — three verdicts,
not two, because "I could not check this from here" is a real answer and must not be filed as a
pass.

`/trace` crosses the two documents in both directions, deterministically: a stage citing a criterion
that no longer exists, or a criterion no stage covers. That is how you find out the spec went stale
while you were implementing, instead of finding out from a verification report that grades your work
against the wrong contract.

→ [Full walkthrough](docs/sdd-workflow.md)

---

## Extend it

Everything that shapes REI's behaviour is a markdown file in your project. Drop one in and it is
there next session — no build, no plugin API, no fork.

**Skills** — a markdown recipe the model loads when the task calls for it, from
`{workspace}/.rei/skills/`. Ships with spec writing, task decomposition, test writing and spec
verification.

**Roles** — a whole posture: which mode it starts in, what it may write, which model it prefers.
`{workspace}/.rei/roles/*.md`:

```markdown
---
name: auditor
description: Adversarial review of a plan BEFORE implementation
baseMode: planning
writeGlob: "*.review.md"
preferredModel: gemma-4-26b-a4b
---
You are an extremely critical Lead Architect. Your ONLY job is to find what is
wrong, missing or risky. You are NOT here to implement or encourage.
```

`/role auditor` switches to it, `/role off` leaves. Both of those fields are enforced, not advice:

- **`writeGlob` is a write scope.** The auditor can persist `plan.review.md` and nothing else — not
  the plan it is reviewing, not your source. It can only ever narrow what the base mode allows.
- **`preferredModel` actually runs.** Which is the point: an auditor on the same weights that wrote
  the code tends to agree with itself. Give the reviewer different weights.

**Project rules** — `{workspace}/.rei/rules.md` is prepended to every turn as mandatory
conventions, and overrides anything generic REI infers about your stack.

**MCP servers** — declared in `rei.config.json`; their tools join the session. Past 25 tools they go
behind a search tool, so a large server does not eat the window.

**Sub-agents** — `/runplan` hands each stage to a worker with a clean context and keeps only its
summary. What the worker read never enters your session.

---

## Beyond code

REI reads documents, not just repositories:

```
/read-document contract.pdf          images, digital PDFs and scanned ones (OCR)
/ask-document what are the payment terms?
/paste-image                         analyse an image from the clipboard
```

Scanned PDFs go through page rendering and a vision model, with rotation detection — a sideways
photo of a page still works.

---

## Privacy, logs and traceability

With a local backend **nothing leaves the machine.** No account, no telemetry endpoint, no code
uploaded for indexing. The only network traffic is between REI and the model server you pointed it
at — `http://localhost:1234`, if that is what you configured.

Telemetry exists for the people who want tracing, and it is opt-in twice over: it needs
`LMNR_PROJECT_API_KEY`, and without it the SDK **is not even loaded**. `REI_TELEMETRY_DISABLED=true`
settles it either way.

Everything REI keeps lives in `.rei/` inside the project, as files you can read:

| Path | What |
|---|---|
| `.rei/logs/agent-flow.jsonl` | one JSON line per event, with `turnId` and `correlationId` |
| `.rei/sessions/` | conversations, resumable with `/session load` |
| `.rei/specs/` · `.rei/plans/` · `.rei/reviews/` | the SDD artifacts |
| `.rei/tool-output/` | full tool output, when a result was too large to inline |
| `.rei/.env` · `rei.config.json` | your configuration |

The log is the traceable part: every turn is a correlated chain — `USER_PROMPT`,
`CONTEXT_SEARCH`, `COMMAND_EXECUTED`, `PATCH_OUTCOME`, `PATCH_QUALITY`. So *"what did it do, and why
did that edit land?"* is answerable afterwards, from disk, with `grep` — which matters when an agent
has write access to your repository.

It is append-only and not rotated (this repo's holds 23k events), and the **code itself is never
copied there** — only what was done to it.

## Use it from anywhere

**Interactive terminal** — `rei`

**One-shot**, for scripts and pipelines. stdout carries the answer and nothing else:

```bash
rei ask   "how is authentication wired?"
rei plan  "add rate limiting to the API"
rei agent "fix the failing test in auth.test.ts"

rei ask "…" --metrics    # timings and token counts on stderr
rei ask "…" --verbose    # plus the reasoning and full tool output
```

**Server** — an OpenAI-compatible API (`/chat/completions`, `/models`), so any IDE extension that
speaks that protocol connects to it, Continue.dev included:

```bash
./install-rei-server-local.sh && rei-server
```

---

## Configuration

The wizard writes everything. These are the ones worth knowing by hand:

| Variable | What |
|---|---|
| `MODEL_PROVIDER` | which backend to use |
| `<PROVIDER>_MODEL` | the model, with `_ASK` / `_PLANNING` / `_AGENT` variants per mode |
| `REI_CONTEXT_WINDOW` | trimming budget; match it to the context your model is loaded with |
| `REI_VERBOSE` | show the reasoning, full command output and full diffs |

Two files, and they are not peers: `<install>/.env` holds the machine's credentials and endpoints,
`<project>/.rei/.env` holds everything about the project. Only credentials and endpoints cross, so
opening REI in a new folder never inherits another project's model.

Per-model tuning — sampling, context window, thinking level — lives in `rei.config.json`, and
**overrides every `.env`**. A model's `contextWindow` there must match the context the backend
actually loaded.

→ [Every variable](docs/config-reference.md) · [How commands are run](docs/command-execution.md)

---

## Advanced, and off by default

First, one default worth knowing: **files reach the model on demand.** REI does not inject a map of
your repository into every turn — the model asks for what it needs with `list_files`, `grep_code`
and `read_files`. On a large repo a proactive map costs hundreds of thousands of tokens per turn,
almost all of them unread. Opt a mode out with `REI_ON_DEMAND_FILE_CONTEXT_<MODE>=0`.

Two subsystems exist and are **not** enabled, because the simpler path measured better:

- **RAG / semantic indexing** (`REI_ENABLE_RAG=1`) — embeddings over the repository. Useful on a
  large codebase; on a normal one, `grep_code` and `read_files` are faster and more accurate.
- **Sandbox edit mode** (`REI_EDIT_MODE=sandbox`) — validates a virtual tree per edit and persists
  only green state. The default, `direct`, applies edits and verifies once at the end; it is lighter
  and, on local models, it wins.

Also here: `/tdd` (append the test command to verification), `/think <level>` (reasoning budget
mid-session), `/index` (build the RAG index).

---

## Documentation

[SDD workflow](docs/sdd-workflow.md) · [Configuration](docs/config-reference.md) ·
[Command execution](docs/command-execution.md) · [Internals](docs/rei-internals.md) ·
[Working rules for contributors](AGENTS.md)

## License

MIT
