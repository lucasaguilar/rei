# REI configuration reference

Every REI env var, how it's resolved, and its scope. Source for the `/doctor` `CONFIG_SPEC`
(`docs/config-doctor-spec.md`). Config lives in a per-workspace `.env` (loaded by
`src/load-env.ts`; the workspace `.env` overrides the install's `~/.rei/.env`).

## Mental model — three groups

1. **Agnostic (`REI_*`)** — apply to any provider.
2. **Per-provider (`<PREFIX>_*`)** — apply only when that provider is active.
   `PREFIX ∈ {LLM_STUDIO, MTPLX, OLLAMA, GEMINI, GROQ, HF, OPENROUTER}`.
3. **Routing** — `MODEL_PROVIDER` (primary), `AGENT_MODEL_PROVIDER` (agent override).

## ⚠️ Precedence — read this before setting anything

Three layers, and the **first one that defines a key wins**:

```
1. rei.config.json      per-model tuning        ← beats everything below
2. <workspace>/.rei/.env   the project
3. <install>/.env       the machine (credentials and endpoints only)
```

This order is the single most common source of "I set it and nothing happened". A value in
`rei.config.json` silently overrides the same setting in every `.env`, so `REI_CONTEXT_WINDOW=65536`
does nothing while the model's entry says `contextWindow: 100352`. When a setting appears not to
apply, **check `rei.config.json` first.**

## Per-model tuning — `rei.config.json`

Sampling, context and thinking belong to the MODEL, not to the installation: Ornith wants a low
temperature, a 27B reasoner wants ~1.0, and a context window that suits one is wrong for the other.
They live in `rei.config.json` at the workspace root, keyed by model id:

```json
{
  "providers": {
    "lmstudio": {
      "models": [
        {
          "id": "ornith-1.5-35b-a3b-mlx",
          "contextWindow": 65536,
          "maxTokens": 16384,
          "temperature": 0.6,
          "topP": 0.95,
          "topK": 20,
          "minP": 0.02,
          "presencePenalty": 0.0,
          "frequencyPenalty": 0.0,
          "reasoningEffort": "medium"
        }
      ]
    }
  }
}
```

| Field | What | Note |
|---|---|---|
| `contextWindow` | REI's trimming budget | **must match the context the model is LOADED with** in LM Studio / Ollama |
| `maxTokens` | output cap **and** the reserve subtracted from the input budget | one value, two jobs — see below |
| `temperature`, `topP`, `topK`, `minP` | sampling | `min_p` and `top_k` are non-standard extensions; local runtimes accept them, strict cloud endpoints may not |
| `presencePenalty`, `frequencyPenalty`, `repetitionPenalty` | anti-repetition | pinned at `0` they silently cancel the `REI_AGENT_*_PENALTY` values from `.env` |
| `reasoningEffort` | thinking budget | `none` / `low` / `medium` / `high` / `xhigh`, if the model honours it |
| `thinkingLevelMap` | maps REI's levels to what the model accepts | for models that reject a level outright |

The model id is matched with the org prefix stripped, so one entry covers `qwen/x`, `orcarouter/x`
and a bare `x`.

**`maxTokens` is subtracted from the input budget**, not added to the window:
`usable input = contextWindow − maxTokens`. Raising it to leave room for a long answer takes that
room away from the prompt.

**`contextWindow` must match the loaded context.** Larger than what the backend loaded and REI sends
more than fits; smaller and the extra KV cache is reserved and never used — which, on a machine with
limited memory, is what produces `[metal::malloc] Resource limit exceeded`.

## How files reach the model — on demand, by default

REI does **not** push a map of your repository into every turn. The model discovers what it needs
with `list_files`, `grep_code` and `read_files`, and REI injects only what it asked for.

This is the default for **all three modes**, with nothing to configure. It matters most on a large
repository, where a proactive skeleton map runs to hundreds of thousands of tokens — most of them
never read, all of them paid for on every turn, and on a local model they crowd out the thing you
actually asked about.

| Var | What | Default |
|---|---|---|
| `REI_ON_DEMAND_FILE_CONTEXT_<MODE>` | per mode: `ASK`, `PLANNING`, `AGENT` | on-demand (`1`) |
| `REI_ON_DEMAND_FILE_CONTEXT` | all modes at once, when no per-mode value is set | on-demand (`1`) |

Set a mode to `0` to opt it back into the proactive map. Worth trying only with a large context
window and a small repository; on anything else the tools win.

This is also why **RAG is off by default** (`REI_ENABLE_RAG`): the two solve the same problem, and
`grep_code` needs no index, no embeddings and no re-indexing when the code changes.

## Sampling has two sources when there is no per-model entry

| Path | Temperature / penalties | Source | Default |
|---|---|---|---|
| **Tools (agent)** | `REI_AGENT_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY` | agnostic (`openai-tool-caller.ts`) | 0.3 |
| **Chat / ask** | `<PREFIX>_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | per-provider (`openai-compatible-provider.ts`) | varies |

Two gotchas, in order of how often they bite:

- A `rei.config.json` entry for the active model **overrides both columns**. Setting `REI_AGENT_*`
  changes nothing while that entry exists.
- With no per-model entry, setting only `<PREFIX>_TEMPERATURE` does not change agent tool-calling —
  that path reads `REI_AGENT_TEMPERATURE`.

## Budget (agnostic, overrides provider)

| Var | What | Default |
|---|---|---|
| `REI_CONTEXT_WINDOW` | context window used for trimming | local = **0 → must set** 🔴 |
| `REI_MAX_OUTPUT_TOKENS` | generation cap | see `model-runtime.ts` |
| `REI_RESPONSE_RESERVE` | tokens reserved for the reply | — |
| `<PREFIX>_CONTEXT_WINDOW` | per-provider window (cloud) | 128000 (cloud) |

Precedence: `REI_CONTEXT_WINDOW` > `<PREFIX>_CONTEXT_WINDOW` > runtime default (local 0).

## Where configuration comes from

Two files, and they are not peers:

| File | Scope | What belongs in it |
|---|---|---|
| `<install>/.env` | the machine | API keys, `*_BASE_URL`, request timeouts, `MODEL_PROVIDER` |
| `<workspace>/.rei/.env` | the project | model per mode, sampling, context, every `REI_*` behaviour flag |

Only machine-scoped keys cross from the install: `*_API_KEY`, `*_TOKEN`, `*_SECRET`,
`*_CLIENT_ID`, `*_BASE_URL`, `*_REQUEST_TIMEOUT_MS`, `MODEL_PROVIDER`, `AGENT_MODEL_PROVIDER`,
`ALLOWED_WORKSPACES`. Everything else must come from the workspace or not at all — otherwise opening
REI in a fresh folder inherits another project's model, sampling and context window, with nothing on
screen to account for them. A real shell variable beats both files.

A legacy `<workspace>/.env` is still read (between the two), so existing projects keep working.
`REI_INHERIT_ALL_ENV=true` restores the old wholesale inheritance.

## Routing & model

`MODEL_PROVIDER` · `AGENT_MODEL_PROVIDER` · `<PREFIX>_BASE_URL` · `<PREFIX>_API_KEY` ·
`<PREFIX>_REQUEST_TIMEOUT_MS`.

> **Credential names are not uniform.** Every provider takes `<PREFIX>_API_KEY` **except Hugging
> Face, which reads `HF_TOKEN`** — its own convention, and the name its hub issues. `HF_API_KEY` is
> not read at all, so setting it looks correct and authenticates nothing.

### Request timeouts

One per provider, all in milliseconds. Local and remote defaults differ on purpose: a 27B on your
own machine can spend minutes on a single reply, while a cloud call that has not answered in two
minutes has failed.

| Var | Default | Why that number |
|---|---|---|
| `LLM_STUDIO_REQUEST_TIMEOUT_MS` | 600000 (10 min) | local inference — a long think is not a hang |
| `MTPLX_REQUEST_TIMEOUT_MS` | 600000 (10 min) | idem |
| `OLLAMA_REQUEST_TIMEOUT_MS` | 300000 (5 min) | local, but usually smaller models |
| `GEMINI_REQUEST_TIMEOUT_MS` | 120000 (2 min) | remote |
| `GROQ_REQUEST_TIMEOUT_MS` | 120000 (2 min) | remote |
| `HF_REQUEST_TIMEOUT_MS` | 120000 (2 min) | remote |
| `OPENROUTER_REQUEST_TIMEOUT_MS` | 120000 (2 min) | remote |

Raise the local ones before blaming the model if a big local reply dies mid-stream. These are
machine-scoped, so they belong in `<install>/.env`.

**One model per mode.** Each mode has an optional override; all fall back to `<PREFIX>_MODEL`,
so setting none keeps a single model for everything:

| Var | Mode | Typically |
|---|---|---|
| `<PREFIX>_MODEL` | fallback for all three | — |
| `<PREFIX>_MODEL_ASK` | ask | interactive — favours a fast model |
| `<PREFIX>_MODEL_PLANNING` | planning | favours the strongest reasoner |
| `<PREFIX>_MODEL_AGENT` | agent | favours a reliable tool-caller |

An empty or whitespace value counts as unset and falls back, so the wizard can write every key
without a blank model name ever reaching the backend.

`AGENT_MODEL_PROVIDER` additionally lets agent mode run on a *different provider*; ask and planning
always use `MODEL_PROVIDER`, so their overrides are read off that provider's prefix.

(`OLLAMA_MODEL_ASK` / `OLLAMA_MODEL_PLANNING` were deprecated while Ollama was the only provider
with per-mode overrides. Every provider has them now, so they are live again — an existing `.env`
carrying them will start taking effect.)

## Agent behavior (agnostic)

| Var | What | Default |
|---|---|---|
| `REI_DEFAULT_MODE` | mode a FRESH session starts in (`ask` \| `planning` \| `agent`) | `agent` |


| Var | What | Default |
|---|---|---|
| `REI_MAX_TURNS` | agent loop turn cap | 12 |
| `REI_EDIT_MODE` | `direct` vs `sandbox` | direct |
| `REI_TDD_MODE` | append `&& npm test` to final verify | false |
| `REI_PRESERVE_THINKING` | re-feed `<think>` (⚠️ loops) | false |
| `REI_ON_DEMAND_FILE_CONTEXT[_ASK/_PLANNING/_AGENT]` | on-demand file context per mode | ask/plan=1, agent=0 |
| `REI_REASONING_EFFORT_[ASK/PLANNING/AGENT]` | thinking cap (none/low/medium/high) | model default |
| `REI_INVESTIGATE_BEFORE_PRODUCE` | produce-or-bail nudge threshold | 8 |
| `AGENT_EDIT_FORMAT` | edit format | — |
| CLI `--session <name>` / `-s` | open/create a named session (parallel agents on one repo) | new auto-id |
| CLI `--continue` / `-c` | resume the most recent session | — |
| CLI `--force` | steal a session lock held by another/stale instance | — |
| CLI `--version` | version plus the build's commit and date (`rei 0.1.0 (ed95a6a, 2026-09-19 12:40)`); `+dirty` marks a build made with uncommitted edits. Stamped by scripts/write-build-info.js on every build — the answer to "which build is this machine running?" | — |
| `REI_SUBAGENT_ENABLED` | expose the `delegate` tool (isolated-context sub-agents) — opt-in | `false` |
| `REI_SUBAGENT_MODEL` | worker model for `delegate` sub-agents (e.g. a fast reliable executor like ornith) | same as agent model |
| `REI_RUNPLAN_DELEGATE` | `/runplan` executes each stage in an isolated sub-agent (report stages excepted) | `true` |
| `REI_ALLOW_SENSITIVE_READS` | let `read_files` serve credential files (.env, .pem, .key, .netrc…) | `false` |
| `REI_VERBOSE` | full command output and full diffs (the reasoning has its own switch below) | `false` |
| `REI_SHOW_REASONING` | the model's thinking as a live paragraph above the status row; `false` counts it instead (one line per block). `REI_VERBOSE` streams it in full | `true` |
| `REI_THINKING_LINES` | rows that paragraph may use (1–12, and never more than a sixth of the terminal) | `4` |
| `REI_LOOP_GUARD` | `off` disables the repetition guard that cuts a runaway generation. On by default; turn it off if it ever stops a legitimately repetitive answer (a long plan with parallel sections is the shape at risk) | `on` |
| `REI_THEME` | colours for REI's chrome: `default` or `matrix`. `/theme` switches mid-session. Diffs and syntax highlighting are never themed | `default` |
| `REI_HYPERLINKS` | `on`/`off` to force or disable clickable file links in tables | auto-detected |

## Execution / tools (agnostic)

| Var | What | Default |
|---|---|---|
| `REI_COMMAND_TIMEOUT_MS` | run_command timeout | 180000 |
| `REI_MAX_COMMAND_OUTPUT` | command output cap | 24000 |
| `REI_ALLOWED_DIRS` | extra dirs outside workspace | — |
| `REI_ALLOWED_COMMANDS` | extra allowed commands | — |
| `REI_SANDBOX_VERIFY_COMMAND` | override verify command | auto by project |
| `REI_CONFIRM_DESTRUCTIVE` | confirm before destructive commands (rm / git reset --hard / clean / checkout --) — interactive CLI only | `true` |
| `REI_CONFIRM_GIT_MUTANT` | confirm before state-mutating git commands (commit / push / merge / rebase) — interactive CLI only | `true` |
| `REI_READ_MAX_LINES` | page size for `read_files`, in lines | 1200 |
| `REI_TOOL_OUTPUT_MAX_INLINE` | tool output kept inline before it spills to disk, in chars — **`0` = nada viaja inline** (todo se vuelca a disco, el modelo ve solo el recibo) | 2000 |
| `REI_TOOL_OUTPUT_PREVIEW` | chars of a spilled output the model still sees as a preview (`0` = receipt only) | 2000 |
| `REI_TOOL_OUTPUT_DIR` | where spilled tool outputs are written | a temp dir, cleaned by the OS |
| `REI_PROMPT_TRACE` | log how much of each prompt is a byte-exact prefix of the previous one (`1` = on) — diagnoses lost KV-cache reuse | off |

**Spilled tool output.** Any tool result over `REI_TOOL_OUTPUT_MAX_INLINE` is written to disk and
replaced, in the model's context, by a receipt naming the file, an id, and exactly how many
lines/chars were omitted. The model gets the rest with `read_files(path)` or copies it elsewhere
with `save_tool_output(id, dest)` — the runtime moves those bytes, so nothing is truncated on the
way. This is the main defence against a single build log eating a local model's window, and it
matters more than it looks: results stay in the turn's history and are re-sent on every remaining
model call, so an unspilled result costs its size once *per step*.

The spill goes to a temp directory because nothing references those files after the process exits —
in the project they became a directory that grew forever with no code to clean it. Point
`REI_TOOL_OUTPUT_DIR` at something inside the workspace if you want them kept for a post-mortem,
and prune it yourself.
| MCP | `MCP_TOOL_TIMEOUT_MS`, `MCP_TOOL_MAX_TIMEOUT_MS` | — |

## OCR / vision (agnostic)

`REI_VISION_MODEL` · `REI_VISION_BASE_URL` · `REI_VISION_API_KEY` · `REI_VISION_MAX_TOKENS` ·
`REI_VISION_FREQUENCY_PENALTY` · `REI_VISION_TIMEOUT_MS` · `REI_OCR_ROTATE` ·
`REI_OCR_MAX_INITIAL_TIMEOUTS` · `REI_OCR_PAGE_PAUSE_MS` · `REI_OCR_SAVE` · `REI_OCR_OUT_DIR` ·
`REI_OCR_INLINE_MAX_CHARS`.

## RAG / embeddings · doc · server · misc

`REI_ENABLE_RAG` (opt-in — the semantic vector index is **OFF by default**: building it on repo
entry is heavy (embeds every file + pulls `sharp`) and it's unused in on-demand file-context
modes; set `=1` only for proactive agent that wants semantic file selection. Legacy
`REI_SKIP_RAG` still forces it OFF and takes precedence). The flat repo map is generated
regardless; a manual `/index` still builds it on demand. ·
`REI_EMBEDDER_PROVIDER/_MODEL/_BASE_URL/_API_KEY` · `REI_TOOL_RAG` · `REI_DOC_VERIFY` ·
`REI_WORKSPACE_PATH` · `ALLOWED_WORKSPACES` · `REI_SERVER_PORT` ·
`REI_SERVER_HOST` (interface the HTTP server binds; default `127.0.0.1` — loopback, because the
server executes commands and writes files in the workspace. Any other value requires
`REI_SERVER_TOKEN` or startup refuses) · `REI_SERVER_TOKEN` (shared secret; when set, every request
needs `Authorization: Bearer <token>`. Unset = no check, which is the default for a loopback-only
server) · `REI_SERVER_ORIGIN` (value of `Access-Control-Allow-Origin` once a token is set; empty
means the header is not sent at all, so browsers cannot call the API. Without a token the header
stays `*`, which IDE clients need. `GET /healthz` is exempt from BOTH: it is the liveness probe a
PaaS calls without headers, and it answers `{"status":"ok"}` and nothing else. `PORT` is honoured as
a fallback for `REI_SERVER_PORT`, which is what Render/Fly/Heroku inject) · `REI_TELEMETRY_DISABLED` ·
`COMPACTOR_MODEL` (which model writes the summary — **leave it empty** to reuse the model already
loaded, which costs no swap and keeps its cached prefix; a name from another backend gives a 404 and
the compaction is skipped) · `<PROVIDER>_MODEL_COMPACTOR` and `<PROVIDER>_MODEL_VISION` (the same
two roles, declared per backend: they win over `COMPACTOR_MODEL` / `REI_VISION_MODEL` when that
provider is the active one, so switching `MODEL_PROVIDER` no longer leaves them naming a model the
new backend has never heard of. Prefixes as in `<PROVIDER>_MODEL`; they follow `MODEL_PROVIDER`,
never `AGENT_MODEL_PROVIDER`. The vision ENDPOINT follows the active provider too when
`REI_VISION_BASE_URL` is unset — otherwise the model came from one backend and the request
went to another) · `COMPACTOR_TIMEOUT_MS` (overrides the timeout; by default it SCALES
with the history — ~30s plus one second per 150 tokens, capped at 15 min — because prefilling a big
history is the slow part and a flat value killed exactly the compactions that were needed) ·
Laminar telemetry `LMNR_*`.

## MTPLX — `chat_template_kwargs`

MTPLX forwards `chat_template_kwargs` to the chat template, which is the **only** way to set the
reasoning level on a Qwen3.8 there: thinking is a template variable, not an engine parameter
(verified — `enable_thinking:false` produced `reasoning_tokens=0`). REI sends them by default.

| Var | What | Default |
|---|---|---|
| `MTPLX_TEMPLATE_KWARGS` | set to `false` to stop forwarding them, if the server's behaviour changes | forwarded |
| `OMLX_TEMPLATE_KWARGS` | same switch for oMLX, which forwards them (measured: `enable_thinking:false` → zero reasoning) | forwarded |
| `OPENAI_COMPAT_TEMPLATE_KWARGS` | set to `true` only when you KNOW the endpoint forwards them — LM Studio answered a fatal backend error and went down | not forwarded |

### oMLX and the generic OpenAI-compatible provider

`omlx` (`OMLX_BASE_URL`, `OMLX_API_KEY`, `OMLX_MODEL`, default `http://127.0.0.1:8000/v1`) exists as
its own provider rather than `lmstudio` pointed elsewhere, because the two endpoints differ in what
they accept: oMLX forwards `chat_template_kwargs`, LM Studio crashes on them. oMLX also answers 401
without a key, even on localhost.

`openai-compat` (`OPENAI_COMPAT_BASE_URL`, `_API_KEY`, `_MODEL`) covers every other OpenAI-compatible
server — vLLM, SGLang, llama.cpp, LiteLLM. Capabilities are declared, never probed.

## Provider-specific sampling/budget cheat-sheet

| Provider | Sampling (chat) | Budget |
|---|---|---|
| LM Studio | `LLM_STUDIO_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | `LLM_STUDIO_MAX_TOKENS` |
| MTPLX | `MTPLX_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | — |
| oMLX | `OMLX_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY`, `OMLX_REQUEST_TIMEOUT_MS` | — |
| OpenAI-compatible (generic) | `OPENAI_COMPAT_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY`, `OPENAI_COMPAT_REQUEST_TIMEOUT_MS` | — |
| Ollama | `OLLAMA_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`, `OLLAMA_NUM_THREAD`, `OLLAMA_KEEP_ALIVE` |
| HF | — | `HF_MAX_TOKENS` |
| OpenRouter | — | `OPENROUTER_CONTEXT_WINDOW` |
