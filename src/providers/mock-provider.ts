import type { ModelProvider, CompletionOptions } from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";

export class MockProvider implements ModelProvider {
  async complete(
    prompt: string,
    _options?: CompletionOptions,
  ): Promise<string> {
    return `Mock completion for: ${prompt.slice(0, 50)}...`;
  }

  async completeChat(
    messages: ChatMessage[],
    _options?: CompletionOptions,
  ): Promise<string> {
    return `Mock assistant response for ${messages.length} messages.`;
  }

  async *streamChat(
    messages: ChatMessage[],
    _options?: CompletionOptions,
  ): AsyncIterable<string> {
    const response = `Mock assistant response for ${messages.length} messages.`;
    const tokens = response.split(" ");

    // Simulate streaming by yielding one token at a time with a delay.
    for (const token of tokens) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield token + " ";
    }
  }
}
