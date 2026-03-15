import type { ModelProvider } from "./model-provider.js";

export class MockProvider implements ModelProvider {
  async complete(prompt: string): Promise<string> {
    return `[mock response]\nPrompt received:\n${prompt}`;
  }
}
