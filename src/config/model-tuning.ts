import { loadReiConfig, type ReiConfig } from "../tools/mcp/mcp-config.js";

/**
 * Per-model tuning read from `rei.config.json` (`providers.<provider>.models[]`) — lets an expert
 * calibrate each local model (sampling, context window, output cap, thinking) WITHOUT touching the
 * global `.env`. Values here take precedence over the global env defaults. The active model's tuning
 * is resolved once per turn and stashed at module level (like the env-based resolvers already do), so
 * the many `getContextWindow()` / `resolveAgentSampling()` call sites don't each need the model name.
 * See docs/model-config-spec.md.
 */
export interface ModelTuning {
  /** Provider model id, e.g. "deepreinforce-ai/ornith-1.0-35b" or the short "ornith-1.0-35b". */
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Non-OpenAI-standard; local runtimes (LM Studio/Ollama) accept it, strict endpoints may not. */
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** HF/vLLM-style multiplicative repetition penalty (1.0 = off). Sent as `repetition_penalty`.
   *  Non-OpenAI-standard; local runtimes (LM Studio/Ollama) accept it, strict endpoints may not. */
  repetitionPenalty?: number;
  /** Min-p nucleus floor (0.0 = off). Sent as `min_p`. Local runtimes accept it, strict endpoints may not. */
  minP?: number;
  /** Intent, not a raw param — REI maps "off" to the runtime's lever (reasoning_effort:none). */
  thinking?: "on" | "off";
  /**
   * This model's default reasoning level (none|minimal|low|medium|high|xhigh). Every other per-model
   * setting — temperature, topP, contextWindow — lives here; the reasoning level used to be stuck in
   * the global `.env`, so switching models meant editing it or re-running `/think` each time.
   *
   * Beats `REI_REASONING_EFFORT_<MODE>`, matching how the rest of the tuning beats its env knob
   * (see resolveAgentSampling). `/think` still wins over both — it is the most recent explicit
   * instruction. The binary `thinking: "off"` remains the shortcut for "no thinking at all".
   */
  reasoningEffort?: string;
  /**
   * Maps REI's reasoning levels to what THIS model accepts. `null` marks a level the model does not
   * support; an absent key passes through untouched, so the map is additive and can never disable a
   * level by omission.
   *
   * REI's whitelist is the OpenAI-standard set (none|minimal|low|medium|high|xhigh), but a model's
   * real range is narrower — Qwen3.8's chat template only knows low/medium/xhigh, and asking for
   * `high` is silently dropped (LM Studio falls back to the field's default), so the request looks
   * fine and nothing changed. Declaring the range makes that visible instead of invisible.
   *
   * A translation like `"high": "xhigh"` is the USER's declared equivalence, not one REI invents.
   */
  thinkingLevelMap?: Record<string, string | null>;
}

type ProvidersConfig = Record<string, { models?: ModelTuning[] }>;

/** Lowercase, strip the provider prefix ("mlx-community/…") and a trailing "-thinking". */
function normalize(modelName: string): string {
  return modelName.toLowerCase().replace(/^.*\//, "").replace(/-thinking$/, "");
}

/** Finds the tuning whose id matches `modelName`.
 *  Checks exact full ID match first (including provider/org prefix, e.g. "mlx-community/ornith-1.0-35b")
 *  to support distinct tunings per quantization/org prefix. Falls back to normalized matching. */
export function matchModel(
  modelName: string,
  models: ModelTuning[],
): ModelTuning | undefined {
  if (!modelName) return undefined;
  const target = modelName.trim().toLowerCase();

  // 1. Exact full ID match (preserves distinctions like mlx-community/ vs deepreinforce-ai/)
  const exact = models.find((m) => m.id.trim().toLowerCase() === target);
  if (exact) return exact;

  // 2. Fallback: normalized match (strips org prefix and -thinking suffix)
  const norm = normalize(modelName);
  if (!norm) return undefined;
  return models.find((m) => {
    const id = normalize(m.id);
    return id.length > 0 && norm === id;
  });
}

/** Resolves the ModelTuning for `modelName` from rei.config.json, or undefined if none matches.
 *  When `providerKey` is provided, searches only that provider's models list (avoids false
 *  positives from a different provider that happens to share a normalized name). */
export function resolveModelTuning(
  modelName: string | undefined,
  workspacePath: string,
  providerKey?: string,
): ModelTuning | undefined {
  if (!modelName) return undefined;
  const config = loadReiConfig(workspacePath) as ReiConfig & {
    providers?: ProvidersConfig;
  };
  const providers = config.providers ?? {};

  // When the caller knows which provider is active, search only that list.
  if (providerKey && providers[providerKey]?.models?.length) {
    const hit = matchModel(modelName, providers[providerKey].models);
    if (hit) return hit;
  }

  // Fallback: search all providers (backward compat for callers that don't pass providerKey).
  for (const provider of Object.values(providers)) {
    const hit = matchModel(modelName, provider.models ?? []);
    if (hit) return hit;
  }
  return undefined;
}

// The active turn's tuning, set once per turn by the agent and read by the config resolvers.
let active: ModelTuning | undefined;

export function setActiveModelTuning(tuning: ModelTuning | undefined): void {
  active = tuning;
}

export function getActiveModelTuning(): ModelTuning | undefined {
  return active;
}
