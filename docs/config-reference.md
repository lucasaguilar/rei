# REI configuration reference

Every REI env var, how it's resolved, and its scope. Source for the `/doctor` `CONFIG_SPEC`
(`docs/config-doctor-spec.md`). Config lives in a per-workspace `.env` (loaded by
`src/load-env.ts`; the workspace `.env` overrides the install's `~/.rei/.env`).

## Mental model — three groups

1. **Agnostic (`REI_*`)** — apply to any provider.
2. **Per-provider (`<PREFIX>_*`)** — apply only when that provider is active.
   `PREFIX ∈ {LLM_STUDIO, MTPLX, OLLAMA, GEMINI, GROQ, HF, OPENROUTER}`.
3. **Routing** — `MODEL_PROVIDER` (primary), `AGENT_MODEL_PROVIDER` (agent override).

## ⚠️ Sampling has two sources depending on the path

| Path | Temperature / penalties | Source | Default |
|---|---|---|---|
| **Tools (agent)** | `REI_AGENT_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY` | agnostic (`openai-tool-caller.ts:119`) | 0.3 |
| **Chat / ask** | `<PREFIX>_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | per-provider (`openai-compatible-provider.ts:256`) | varies |

Gotcha: setting only `<PREFIX>_TEMPERATURE` does **not** change agent tool-calling — that
path reads `REI_AGENT_TEMPERATURE` (default 0.3). Set `REI_AGENT_*` to tune the agent.

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
| `REI_MAX_TURNS` | agent loop turn cap | 12 |
| `REI_EDIT_MODE` | `direct` vs `sandbox` | direct |
| `REI_TDD_MODE` | append `&& npm test` to final verify | false |
| `REI_PRESERVE_THINKING` | re-feed `<think>` (⚠️ loops) | false |
| `REI_ON_DEMAND_FILE_CONTEXT[_ASK/_PLANNING/_AGENT]` | on-demand file context per mode | ask/plan=1, agent=0 |
| `REI_REASONING_EFFORT_[ASK/PLANNING/AGENT]` | thinking cap (none/low/medium/high) | model default |
| `REI_INVESTIGATE_BEFORE_PRODUCE` | produce-or-bail nudge threshold | 8 |
| `REI_VERBATIM_HISTORY_TURNS` | turns kept verbatim before demotion | 3 |
| `AGENT_EDIT_FORMAT` | edit format | — |
| CLI `--session <name>` / `-s` | open/create a named session (parallel agents on one repo) | new auto-id |
| CLI `--continue` / `-c` | resume the most recent session | — |
| CLI `--force` | steal a session lock held by another/stale instance | — |
| `REI_SUBAGENT_ENABLED` | expose the `delegate` tool (isolated-context sub-agents) — opt-in | `false` |
| `REI_SUBAGENT_MODEL` | worker model for `delegate` sub-agents (e.g. a fast reliable executor like ornith) | same as agent model |
| `REI_RUNPLAN_DELEGATE` | `/runplan` executes each stage in an isolated sub-agent (report stages excepted) | `true` |
| `REI_ALLOW_SENSITIVE_READS` | let `read_files` serve credential files (.env, .pem, .key, .netrc…) | `false` |

## Execution / tools (agnostic)

| Var | What | Default |
|---|---|---|
| `REI_COMMAND_TIMEOUT_MS` | run_command timeout | 180000 |
| `REI_MAX_COMMAND_OUTPUT` | command output cap | 24000 |
| `REI_ALLOWED_DIRS` | extra dirs outside workspace | — |
| `REI_ALLOWED_COMMANDS` | extra allowed commands | — |
| `REI_SANDBOX_VERIFY_COMMAND` | override verify command | auto by project |
| `REI_CONFIRM_DESTRUCTIVE` | confirm before destructive commands (rm / git reset --hard / clean / checkout --) — interactive CLI only | `true` |
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
`REI_WORKSPACE_PATH` · `ALLOWED_WORKSPACES` · `REI_SERVER_PORT` · `REI_TELEMETRY_DISABLED` ·
`COMPACTOR_MODEL` · Laminar telemetry `LMNR_*`.

## Provider-specific sampling/budget cheat-sheet

| Provider | Sampling (chat) | Budget |
|---|---|---|
| LM Studio | `LLM_STUDIO_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | `LLM_STUDIO_MAX_TOKENS` |
| MTPLX | `MTPLX_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | — |
| Ollama | `OLLAMA_TEMPERATURE / _FREQUENCY_PENALTY / _PRESENCE_PENALTY / _REPEAT_PENALTY` | `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`, `OLLAMA_NUM_THREAD`, `OLLAMA_KEEP_ALIVE` |
| HF | — | `HF_MAX_TOKENS` |
| OpenRouter | — | `OPENROUTER_CONTEXT_WINDOW` |
