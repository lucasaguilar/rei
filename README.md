# REI

**A local-first coding agent that verifies every edit against your project's real compiler.**

Run it against a model on your own machine, or against a cloud one — same tool, same commands. It
reads your repository, proposes changes, applies them, and checks them against `tsc`, `ngc`,
`go build`, `cargo check` or whatever your project actually uses. What it tells you compiles,
compiled.

<!-- TODO: demo gif -->

---

## Start in under a minute

```bash
git clone https://github.com/<you>/rei && cd rei
./install-rei-cli-local.sh
```

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

Different **providers** per mode work too: explore with a local model, execute with a cloud one.

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

So REI does not take the model's word. It detects what the project is — Angular, TypeScript, Go,
Rust, Python, C#, Roblox/Luau — and runs that project's real verify command against the edits. A
failure goes back to the model to fix, with the compiler's own message.

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

- **Skills** — reusable recipes in plain markdown (`prompts/skills/`). Write one, and the model
  loads it when the task calls for it. Ships with spec writing, task decomposition, test writing and
  spec verification.
- **MCP servers** — declare them in `rei.config.json` and their tools join the session. When a
  server exposes more than 25 tools they go behind a search tool, so a big server does not eat the
  context window.
- **Roles** — `/role auditor` swaps posture and permissions for a review pass.
- **Sub-agents** — `/runplan` hands each stage to a worker with a clean context, and keeps only its
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

Per-model tuning — sampling, context window, thinking level — lives in `rei.config.json`.

→ [Every variable](docs/config-reference.md) · [How commands are run](docs/command-execution.md)

---

## Advanced, and off by default

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
