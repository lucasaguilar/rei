import type {
  ModelProvider,
  CompletionOptions,
  ToolDefinition,
  ChatCompletionWithTools,
} from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";

export class MockProvider implements ModelProvider {
  /**
   * Optional scripted tool-calling turns, consumed in order by completeChatWithTools. Lets tests
   * drive the native tools loop deterministically (e.g. turn 1 → an edit_file call, turn 2 → a
   * plain-text completion). When the queue is empty, a default plain-text "stop" turn is returned.
   */
  private readonly scriptedToolTurns: ChatCompletionWithTools[];

  constructor(scriptedToolTurns: ChatCompletionWithTools[] = []) {
    this.scriptedToolTurns = [...scriptedToolTurns];
  }

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

  async completeChatWithTools(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options?: CompletionOptions,
  ): Promise<ChatCompletionWithTools> {
    const scripted = this.scriptedToolTurns.shift();
    if (scripted) return scripted;
    return {
      content: `Mock assistant response for ${messages.length} messages.`,
      toolCalls: [],
      finishReason: "stop",
    };
  }
}
