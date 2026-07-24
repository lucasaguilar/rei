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
  /** Intent, not a raw param — REI maps "off" to the runtime's lever (reasoning_effort:none). */
  thinking?: "on" | "off";
}

type ProvidersConfig = Record<string, { models?: ModelTuning[] }>;

/** Lowercase, strip the provider prefix ("mlx-community/…") and a trailing "-thinking". */
function normalize(modelName: string): string {
  return modelName.toLowerCase().replace(/^.*\//, "").replace(/-thinking$/, "");
}

/** Finds the tuning whose id matches `modelName` (exact after normalization, or the config id is a
 *  prefix of the active name). Precise on purpose — no fuzzy two-way `includes`. */
export function matchModel(
  modelName: string,
  models: ModelTuning[],
): ModelTuning | undefined {
  const norm = normalize(modelName);
  if (!norm) return undefined;
  return models.find((m) => {
    const id = normalize(m.id);
    return id.length > 0 && (norm === id || norm.startsWith(id));
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
