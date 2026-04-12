import type { ModelProvider } from "./model-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { MockProvider } from "./mock-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { HuggingFaceProvider } from "./huggingface-provider.js";

export type ProviderName =
  | "mock"
  | "ollama"
  | "groq"
  | "gemini"
  | "openrouter"
  | "huggingface";

export function createModelProvider(providerNameArg?: string): ModelProvider {
  const providerName = (
    providerNameArg ??
    process.env.MODEL_PROVIDER ??
    "mock"
  ).toLowerCase();

  switch (providerName) {
    case "mock":
      return new MockProvider();
    case "ollama":
      return new OllamaProvider();
    case "groq":
      return new GroqProvider();
    case "gemini":
      return new GeminiProvider();
    case "openrouter":
      console.log("Creating OpenRouterProvider with");
      return new OpenRouterProvider();
    case "huggingface":
      return new HuggingFaceProvider();
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER: ${providerNameArg ?? process.env.MODEL_PROVIDER}. Expected one of: mock, ollama, groq, gemini, openrouter, huggingface`,
      );
  }
}
