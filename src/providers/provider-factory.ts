import type { ModelProvider } from "./model-provider.js";
import type { SessionMode } from "../chat/types.js";
import { GeminiProvider } from "./gemini-provider.js";
import { LlmStudioProvider } from "./llm-studio-provider.js";
import { MockProvider } from "./mock-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { HuggingFaceProvider } from "./huggingface-provider.js";
import { withDegenerateGuard } from "./degenerate-guard.js";
import { withTelemetry } from "./with-telemetry.js";

export type ProviderName =
  | "mock"
  | "ollama"
  | "groq"
  | "gemini"
  | "openrouter"
  | "huggingface"
  | "llmstudio";

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
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER: ${providerNameArg ?? process.env.MODEL_PROVIDER}. Expected one of: mock, ollama, groq, gemini, openrouter, huggingface, llmstudio`,
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

/**
 * Resolves the model name for a given session mode.
 *
 * - Agent mode with AGENT_MODEL_PROVIDER: reads <PROVIDER>_MODEL_AGENT
 *   (e.g. OPENROUTER_MODEL_AGENT) and falls back to the provider default.
 * - Ollama single-provider: reads OLLAMA_MODEL_{AGENT|ASK|PLANNING}.
 * - All other providers: returns undefined (provider uses its own default).
 */
export function resolveModelForMode(mode: SessionMode): string | undefined {
  const primaryProvider = (process.env.MODEL_PROVIDER ?? "llmstudio").toLowerCase().trim();
  const agentProvider = (process.env.AGENT_MODEL_PROVIDER || primaryProvider).toLowerCase().trim();

  // Agent mode resolves its corresponding _AGENT or default model variable depending on active agent provider.
  if (mode === "agent") {
    switch (agentProvider) {
      case "openrouter":
        return process.env.OPENROUTER_MODEL_AGENT ?? process.env.OPENROUTER_MODEL;
      case "ollama":
        return process.env.OLLAMA_MODEL_AGENT ?? process.env.OLLAMA_MODEL;
      case "groq":
        return process.env.GROQ_MODEL_AGENT ?? process.env.GROQ_MODEL;
      case "gemini":
        return process.env.GEMINI_MODEL_AGENT ?? process.env.GEMINI_MODEL;
      case "huggingface":
        return process.env.HF_MODEL_AGENT ?? process.env.HF_MODEL;
      case "llmstudio":
        return process.env.LLM_STUDIO_MODEL_AGENT ?? process.env.LLM_STUDIO_MODEL;
      default:
        return undefined;
    }
  }

  // Single-provider setup: only Ollama supports specific per-mode model overrides (like OLLAMA_MODEL_ASK, OLLAMA_MODEL_PLANNING).
  if (primaryProvider === "ollama") {
    switch (mode) {
      case "ask":
        return process.env.OLLAMA_MODEL_ASK ?? process.env.OLLAMA_MODEL;
      case "planning":
        return process.env.OLLAMA_MODEL_PLANNING ?? process.env.OLLAMA_MODEL;
      default:
        return process.env.OLLAMA_MODEL;
    }
  }

  return undefined;
}
