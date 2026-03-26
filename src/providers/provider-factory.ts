import type { ModelProvider } from "./model-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { MockProvider } from "./mock-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { GroqProvider } from "./groq-provider.js";

export type ProviderName = "mock" | "ollama" | "groq" | "gemini";

export function createModelProvider(): ModelProvider {
  const providerName = (process.env.MODEL_PROVIDER ?? "mock").toLowerCase();

  switch (providerName) {
    case "mock":
      return new MockProvider();
    case "ollama":
      return new OllamaProvider();
    case "groq":
      return new GroqProvider();
    case "gemini":
      return new GeminiProvider();
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER: ${process.env.MODEL_PROVIDER}. Expected one of: mock, ollama, groq, gemini`
      );
  }
}
