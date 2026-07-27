# Mini-spec: per-model config (unified with RECOMMENDED_MODELS)

Status: **SPEC (defined, not implemented).** Supersedes the mechanism proposals in
`docs/local-model-configuration.md` (keep that as the raw notes / the value tables).

## Goal & problem

Today REI has ONE global sampling set (`REI_AGENT_TEMPERATURE/_FREQUENCY_PENALTY/_PRESENCE_PENALTY`,
default 0.3) applied to every model, and ONE global `REI_CONTEXT_WINDOW`. But optimal values differ
per model (Ornith runs low-temp; qwen-35b-a3b wants ~0.6), and the single context window is the
config-doctor's #1 footgun — you forget to update it when you switch models. We want **per-model
tuning** without config sprawl or breaking the current env-based setup.

## The unified model registry (two layers, one shape)

There is ONE per-model shape, filled from two sources:

- **Built-in defaults = `RECOMMENDED_MODELS`** (the config-doctor's table, `docs/config-doctor-spec.md`).
  Ships good values out of the box; codifies what we've validated. Also carries the config-doctor's
  reliability/fit info — so this is a SINGLE model registry feeding both features, not two.
- **User overrides = a `providers` section in the existing `rei.config.json`** (Pi-style). REI already
  reads `rei.config.json` for MCP (`src/tools/mcp/mcp-config.ts`) — reuse that reader; do NOT add a
  new `models.json` file.

```jsonc
// rei.config.json (workspace root) — mcpServers stays; add "providers":
{
  "mcpServers": { /* ... */ },
  "providers": {
    "lmstudio": {
      "models": [
        {
          "id": "deepreinforce-ai/ornith-1.0-35b",
          "contextWindow": 65536,
          "maxTokens": 8192,
          "temperature": 0.35,
          "frequencyPenalty": 0.8,
          "presencePenalty": 0.6,
          "thinking": "off"
        }
      ]
    }
  }
}
```

### Per-model shape
```ts
interface ModelTuning {
  id: string;                 // provider model id (e.g. "qwen/qwen3.6-35b-a3b")
  contextWindow?: number;     // trimming budget for THIS model → kills the global-window footgun
  maxTokens?: number;         // output cap for THIS model
  temperature?: number;       // agent tools-path sampling (see the sampling-duality note below)
  frequencyPenalty?: number;
  presencePenalty?: number;
  thinking?: "on" | "off";    // INTENT, not a raw param — REI maps it to the runtime's lever
  reliableToolCalling?: boolean; // for the config-doctor / model-fit (registry is shared)
}
```

## Precedence (resolved per parameter)

Most specific wins; existing setups keep working:

1. **`rei.config.json` per-model value** (user, model-specific) — highest.
2. **Explicit env** — `REI_AGENT_<PARAM>` / `REI_CONTEXT_WINDOW` / `<PREFIX>_*`, detected via
   `process.env.X !== undefined` (a user who set it wins over our defaults).
3. **Built-in `RECOMMENDED_MODELS[activeModel]`** (our validated/estimated default for that model).
4. **Hardcoded default** (temp 0.3; local window 0).

So: a user with `REI_AGENT_TEMPERATURE` set keeps it; a user without it gets the smart per-model
default; a power user overrides per model in `rei.config.json`. Non-breaking.

## `thinking` is intent, not `reasoning_effort` (the runtime-dependent lever)

Verified this session: the thinking-disable lever is **runtime-dependent**, and graduated levels
don't exist on binary models:
- **LM Studio + qwen3.6-35b-a3b:** `reasoning_effort: none` turns thinking OFF (verified); `/no_think`
  and `enable_thinking:false` are IGNORED. The model is BINARY — only `none` matters; low/medium/high
  all = full thinking.
- **mlx_lm.server:** `reasoning_effort` is IGNORED; `/no_think` / `enable_thinking:false` is the lever.
- **Ornith:** not a thinking model → moot.

So the config expresses **intent** (`"thinking": "off"`) and REI translates to whatever the active
runtime honors (reasoning_effort for LM Studio, `/no_think` injection for mlx_lm). Do NOT put a raw
`reasoning_effort` in the file — it would silently no-op on runtimes that ignore it. This also
supersedes leaning on `REI_REASONING_EFFORT_<MODE>` alone (see [[rei-reasoning-effort-per-mode]]).

## The context-window win

Per-model `contextWindow` (from the config or the built-in table) removes the config-doctor's 🔴 #1
footgun: switching models auto-uses the right window instead of silently reusing a stale global
`REI_CONTEXT_WINDOW`. For a known model the local-window-unset danger disappears.

## Plumbing

- **`resolveAgentSampling()` → `resolveAgentSampling(modelName?)`** in `src/config/model-runtime.ts`.
  Thread the active model name to the call site (`openai-tool-caller.ts` builds the body without it
  today — pass it down from the provider/generator). Sampling stays on the AGENT tools path (the
  duality: chat/ask still uses `<PREFIX>_TEMPERATURE`; see `docs/config-reference.md`).
- **`getContextWindow()` / `getMaxOutputTokens()`** gain a per-model lookup at the same precedence.
- **Name normalization + lookup:** lowercase, strip provider prefix (`mlx-community/…`) and a trailing
  `-thinking`. Match by **exact normalized id or prefix** — NOT the fuzzy `key.includes(normalized) ||
  normalized.includes(key)` from the notes (a short key mis-matches). Unknown model → fall through.
- **Registry module:** one `RECOMMENDED_MODELS: ModelTuning[]` (shared with config-doctor) + a loader
  that merges `rei.config.json` `providers[*].models[*]` over it by id.

## Honest caveat on the values

Only **Ornith** and **qwen3.6-35b-a3b** were actually exercised in REI. The rest (gemma, qwen3.6-27b,
the exact penalties, `frequencyPenalty: 0.8`) are the authoring model's estimates — some claims in the
raw notes (ornith "self-scaffolding RL", qwen "77.2% SWE-bench") are unverified. Ship the table as
**starting points to tune per result**, commented as validated vs estimated. Not gospel.

## Implementation phases

1. **Registry + built-in defaults.** `ModelTuning` type + `RECOMMENDED_MODELS` array (shared with the
   config-doctor). Pure, testable. No behavior change yet.
2. **Per-model sampling.** `resolveAgentSampling(model)` with the precedence chain + name normalization;
   thread the model name to the tools-path body. Tests per precedence level.
3. **Per-model context/output.** `getContextWindow`/`getMaxOutputTokens` per-model lookup → the
   footgun fix.
4. **`rei.config.json` `providers.models[]` loader.** Merge user overrides over the built-in table
   (reuse the MCP config reader).
5. **`thinking` intent → runtime lever.** Map `"off"` to `reasoning_effort:none` (LM Studio) or
   `/no_think` injection (mlx_lm) by detecting the runtime; leave a manual escape.

Phase 1 also directly advances the config-doctor (`RECOMMENDED_MODELS` is the shared registry).

## Connections
`[[rei-config-doctor-proposal]]` (RECOMMENDED_MODELS is shared) · `[[rei-reasoning-effort-per-mode]]`
(the binary/runtime caveats) · `[[rei-model-selection-per-mode]]` (env model selection stays) ·
`docs/config-reference.md` (the sampling duality).
