import type { ModelProvider } from "./model-provider.js";
import type { SessionMode } from "../chat/types.js";
import { GeminiProvider } from "./gemini-provider.js";
import { LlmStudioProvider } from "./llm-studio-provider.js";
import { MockProvider } from "./mock-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { HuggingFaceProvider } from "./huggingface-provider.js";
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
  | "llmstudio"
  | "mtplx";

export function createModelProvider(providerNameArg?: string): ModelProvider {
  const providerName = (
    providerNameArg ??
    process.env.MODEL_PROVIDER ??
    "mock"
  ).toLowerCase();
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
    case "llmstudio":
      provider = new LlmStudioProvider();
      break;
    case "mtplx":
      provider = new MtplxProvider();
      break;
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER: ${providerNameArg ?? process.env.MODEL_PROVIDER}. Expected one of: mock, ollama, groq, gemini, openrouter, huggingface, llmstudio, mtplx`,
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
  llmstudio: "LLM_STUDIO",
  mtplx: "MTPLX",
};

/** Trims a value and treats "" / whitespace as unset (so empty env vars fall back). */
function cleanEnvModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves the model name for a given session mode — uniformly across ALL providers:
 *   - ask / planning → `<PROVIDER>_MODEL`
 *   - agent          → `<PROVIDER>_MODEL_AGENT` (falls back to `<PROVIDER>_MODEL`)
 *
 * Agent mode may target a dedicated provider via AGENT_MODEL_PROVIDER; ask/planning
 * always use MODEL_PROVIDER. Returns undefined for unknown providers, so the provider
 * falls back to its own constructor default.
 *
 * Note: OLLAMA_MODEL_ASK / OLLAMA_MODEL_PLANNING are deprecated (Ollama used to be the
 * only provider with per-mode overrides) — ask/planning now use OLLAMA_MODEL like the rest.
 */
export function resolveModelForMode(mode: SessionMode): string | undefined {
  const primaryProvider = (process.env.MODEL_PROVIDER ?? "llmstudio")
    .toLowerCase()
    .trim();
  const provider =
    mode === "agent"
      ? (process.env.AGENT_MODEL_PROVIDER || primaryProvider)
          .toLowerCase()
          .trim()
      : primaryProvider;

  const prefix = PROVIDER_ENV_PREFIX[provider];
  if (!prefix) return undefined;

  // Treat empty/whitespace env values as unset so an empty <PREFIX>_MODEL_AGENT (e.g.
  // written by the config wizard when no dedicated agent model is chosen) falls back to
  // <PREFIX>_MODEL instead of sending an empty model name to the backend.
  const base = cleanEnvModel(process.env[`${prefix}_MODEL`]);
  if (mode === "agent") {
    return cleanEnvModel(process.env[`${prefix}_MODEL_AGENT`]) ?? base;
  }
  return base;
}
