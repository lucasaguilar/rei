import type { ChatMessage } from "../chat/types.js";

export interface ModelProvider {
  complete(prompt: string): Promise<string>;
  completeChat(messages: ChatMessage[]): Promise<string>;
  streamChat?(messages: ChatMessage[]): AsyncIterable<string>;
}
