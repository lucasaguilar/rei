import type { ModelProvider } from "../providers/model-provider.js";

export class Agent {
  constructor(private readonly provider: ModelProvider) {}

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }
}
