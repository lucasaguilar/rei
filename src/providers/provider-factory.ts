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
