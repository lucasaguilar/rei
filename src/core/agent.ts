import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatSession } from "../chat/types.js";
import { buildSystemMessage } from "../prompts/prompt-builder.js";

export class Agent {
  constructor(private readonly provider: ModelProvider) {}

  async run(prompt: string): Promise<string> {
    return this.provider.complete(prompt);
  }

  async runTurn(session: ChatSession, userInput: string): Promise<string> {
    const systemContent = buildSystemMessage(session.mode);

    // Keep the system message at position 0 reflecting the current mode.
    if (session.messages.length > 0 && session.messages[0].role === "system") {
      session.messages[0] = { role: "system", content: systemContent };
    } else {
      session.messages.unshift({ role: "system", content: systemContent });
    }

    session.messages.push({ role: "user", content: userInput });
    const response = await this.provider.completeChat(session.messages);
    session.messages.push({ role: "assistant", content: response });
    return response;
  }
}
