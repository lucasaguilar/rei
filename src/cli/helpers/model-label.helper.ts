import type { SessionMode } from "../../chat/types.js";
import { resolveModelForMode } from "../../providers/provider-factory.js";
import { normalizeProviderName } from "../../providers/provider-names.js";

/**
 * Resolves the active model label and maps it to its corresponding brand icon or emoji
 * (e.g. 🦙 for Ollama, 🧠 for OpenRouter, ⚡ for Groq, ♊ for Gemini, 💻 for LM Studio).
 * Supports dedicated agent provider resolution in multi-provider environments.
 */
export function resolveActiveModelLabel(
  mode?: string,
  actualModel?: string,
): string {
  const isAgentMode = mode === "agent";
  const agentProvider = normalizeProviderName(process.env.AGENT_MODEL_PROVIDER ?? "");

  const provider =
    isAgentMode && agentProvider
      ? agentProvider
      : normalizeProviderName(process.env.MODEL_PROVIDER ?? "");

  // `actualModel` is what the turn REPORTED running on, and it wins: an active role's
  // preferredModel changes the model without changing the mode, so re-deriving from the mode
  // named the wrong one. The resolver is the fallback for before any turn has run (startup gauge).
  const modelName =
    actualModel ||
    resolveModelForMode((mode as SessionMode) ?? "ask") ||
    "default";

  const emoji: Record<string, string> = {
    ollama: "🦙",
    openrouter: "🧠",
    groq: "⚡",
    gemini: "♊",
    huggingface: "🤗",
    lmstudio: "💻",
    mock: "🧪",
  };

  if (!provider) return "unknown";
  const icon = emoji[provider] ?? "";
  // Show provider / model so it's clear which backend AND model is active per mode.
  return `${icon ? icon + " " : ""}${provider} / ${modelName}`;
}
