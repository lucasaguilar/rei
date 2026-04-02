import type { ChatMessage } from "../chat/types.js";

export interface CompletionOptions {
  model?: string;
}

export interface ModelProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  completeChat(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
  streamChat?(messages: ChatMessage[], options?: CompletionOptions): AsyncIterable<string>;
}
