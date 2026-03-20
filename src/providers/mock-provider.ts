import type { ModelProvider } from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";

export class MockProvider implements ModelProvider {
  async complete(prompt: string): Promise<string> {
    return `[mock response]\nPrompt received:\n${prompt}`;
  }

  async completeChat(messages: ChatMessage[]): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    return `[mock response] You said: ${lastUser?.content ?? ""}`;
  }

  async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const response = `[mock response] You said: ${lastUser?.content ?? ""}`;
    const tokens = response.split(" ");
    for (const token of tokens) {
      yield token + " ";
    }
  }
}
