import type { ModelProvider } from "./model-provider.js";
import type { SessionMode } from "../chat/types.js";
import { GeminiProvider } from "./gemini-provider.js";
import { LmStudioProvider } from "./lm-studio-provider.js";
import { normalizeProviderName } from "./provider-names.js";
import { MockProvider } from "./mock-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { HuggingFaceProvider } from "./huggingface-provider.js";
import { OmlxProvider } from "./omlx-provider.js";
import { OpenAiCompatProvider } from "./openai-compat-provider.js";
import { MtplxProvider } from "./mtplx-provider.js";
import { withDegenerateGuard } from "./degenerate-guard.js";
import { withTelemetry } from "./with-telemetry.js";

export type ProviderName =
  | "mock"
  | "ollama"
  | "groq"
  | "gemini"
  | "openrouter"
  | "huggingface"
  | "lmstudio"
  | "mtplx"
  | "omlx"
  | "openai-compat";

export function createModelProvider(providerNameArg?: string): ModelProvider {
  // Normalised here rather than at each call site: this is where a provider name arrives from the
  // outside world (env, flag, `/provider`), and an `.env` written before the `llmstudio` → `lmstudio`
  // rename must keep starting the same provider.
  const providerName = normalizeProviderName(
    providerNameArg ?? process.env.MODEL_PROVIDER ?? "mock",
  );
  let provider: ModelProvider;

  switch (providerName) {
    case "mock":
      provider = new MockProvider();
      break;
    case "ollama":
      provider = new OllamaProvider();
      break;
    case "groq":
      provider = new GroqProvider();
      break;
    case "gemini":
      provider = new GeminiProvider();
      break;
    case "openrouter":
      provider = new OpenRouterProvider();
      break;
    case "huggingface":
      provider = new HuggingFaceProvider();
      break;
    case "lmstudio":
      provider = new LmStudioProvider();
      break;
    case "mtplx":
      provider = new MtplxProvider();
      break;
    case "omlx":
      provider = new OmlxProvider();
      break;
    case "openai-compat":
      provider = new OpenAiCompatProvider();
      break;
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER: ${providerNameArg ?? process.env.MODEL_PROVIDER}. Expected one of: mock, ollama, groq, gemini, openrouter, huggingface, lmstudio, mtplx, omlx, openai-compat`,
      );
  }

  return withTelemetry(withDegenerateGuard(provider), providerName);
}

/**
 * Creates a provider for the given mode. When AGENT_MODEL_PROVIDER is set,
 * agent mode uses a dedicated provider (e.g. openrouter) while ask/planning
 * continue using the default MODEL_PROVIDER (e.g. ollama local).
 * Returns the defaultProvider unchanged for all other modes.
 */
export function createProviderForMode(
  mode: SessionMode,
  defaultProvider: ModelProvider,
): ModelProvider {
  if (mode !== "agent") return defaultProvider;

  const agentProviderName =
    process.env.AGENT_MODEL_PROVIDER?.toLowerCase().trim();
  if (!agentProviderName) return defaultProvider;

  return createModelProvider(agentProviderName);
}

/** Env-var prefix per provider. Not uniform (HF, LLM_STUDIO), so it's mapped explicitly. */
const PROVIDER_ENV_PREFIX: Record<string, string> = {
  ollama: "OLLAMA",
  openrouter: "OPENROUTER",
  groq: "GROQ",
  gemini: "GEMINI",
  huggingface: "HF",
  lmstudio: "LLM_STUDIO",
  mtplx: "MTPLX",
  omlx: "OMLX",
  "openai-compat": "OPENAI_COMPAT",
};

/** Per-mode model override suffix, appended to the provider prefix. */
const MODE_ENV_SUFFIX: Record<SessionMode, string> = {
  ask: "_MODEL_ASK",
  planning: "_MODEL_PLANNING",
  agent: "_MODEL_AGENT",
};

/**
 * Helper models that are not a conversation mode: the one that summarises a session, and the one
 * that reads images. Same `<PROVIDER>_MODEL_*` shape as the modes above, for the same reason.
 *
 * They used to be single global vars (`COMPACTOR_MODEL`, `REI_VISION_MODEL`), which meant that
 * switching `MODEL_PROVIDER` — the one knob that is supposed to switch everything — left them
 * pointing at a model from the previous backend. The real failure that follows is not obvious:
 * `COMPACTOR_MODEL=qwen/qwen3-4b` (an LM Studio name) against oMLX 404s, compaction is skipped,
 * and the session sails past its window instead of being summarised.
 */
const ROLE_ENV_SUFFIX = {
  compactor: "_MODEL_COMPACTOR",
  vision: "_MODEL_VISION",
} as const;

export type ModelRole = keyof typeof ROLE_ENV_SUFFIX;

/** Trims a value and treats "" / whitespace as unset (so empty env vars fall back). */
function cleanEnvModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves the model name for a given session mode — uniformly across ALL providers. Every mode
 * has its own optional override, each falling back to the shared `<PROVIDER>_MODEL`:
 *   - ask      → `<PROVIDER>_MODEL_ASK`
 *   - planning → `<PROVIDER>_MODEL_PLANNING`
 *   - agent    → `<PROVIDER>_MODEL_AGENT`
 *
 * Modes want different things: ask is interactive and wants a fast model, planning wants the
 * strongest reasoner, agent wants a reliable tool-caller. Setting none of the overrides keeps the
 * single `<PROVIDER>_MODEL` for everything, so existing configs behave exactly as before.
 *
 * Agent mode may target a dedicated provider via AGENT_MODEL_PROVIDER; ask/planning always use
 * MODEL_PROVIDER. Returns undefined for unknown providers, so the provider falls back to its own
 * constructor default.
 */
export function resolveModelForMode(mode: SessionMode): string | undefined {
  const primaryProvider = normalizeProviderName(
    process.env.MODEL_PROVIDER ?? "lmstudio",
  );
  const provider =
    mode === "agent"
      ? normalizeProviderName(process.env.AGENT_MODEL_PROVIDER || primaryProvider)
      : primaryProvider;

  const prefix = PROVIDER_ENV_PREFIX[provider];
  if (!prefix) return undefined;

  // Treat empty/whitespace env values as unset so an empty <PREFIX>_MODEL_AGENT (e.g.
  // written by the config wizard when no dedicated agent model is chosen) falls back to
  // <PREFIX>_MODEL instead of sending an empty model name to the backend.
  const base = cleanEnvModel(process.env[`${prefix}_MODEL`]);
  return cleanEnvModel(process.env[`${prefix}${MODE_ENV_SUFFIX[mode]}`]) ?? base;
}

/**
 * The model for a helper role on the ACTIVE provider — `<PROVIDER>_MODEL_COMPACTOR`,
 * `<PROVIDER>_MODEL_VISION`.
 *
 * Returns undefined when nothing is set for this provider, and the caller then falls back to its
 * own global (`COMPACTOR_MODEL`, `REI_VISION_MODEL`) exactly as before. That order is what lets
 * both spellings coexist: keep one global if a single model serves every backend, or declare one
 * per provider and stop editing .env every time `MODEL_PROVIDER` changes.
 *
 * Reads MODEL_PROVIDER only — never AGENT_MODEL_PROVIDER. Summarising a session and reading an
 * image are not the agent's work, and inheriting the agent's dedicated backend for them would be
 * surprising in exactly the setup that flag exists for.
 */
export function resolveModelForRole(role: ModelRole): string | undefined {
  const provider = normalizeProviderName(process.env.MODEL_PROVIDER ?? "lmstudio");
  const prefix = PROVIDER_ENV_PREFIX[provider];
  if (!prefix) return undefined;
  return cleanEnvModel(process.env[`${prefix}${ROLE_ENV_SUFFIX[role]}`]);
}
