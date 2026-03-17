import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatSession } from "../chat/types.js";

export class Agent {
  constructor(private readonly provider: ModelProvider) {}

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }

  async runTurn(session: ChatSession, userInput: string): Promise<string> {
    session.messages.push({ role: "user", content: userInput });
    const response = await this.provider.completeChat(session.messages);
    session.messages.push({ role: "assistant", content: response });
    return response;
  }
}
