import type { ChatMessage } from "./types.js";

/**
 * Builds the message array to send to the model provider.
 *
 * The full conversation history lives in session.messages and is never
 * mutated here. This function produces a reduced window so that prompts
 * do not grow unbounded — which is especially important when integrating
 * local models such as Ollama that have limited context windows.
 *
 * Repository-aware context is re-injected into each turn's user message
 * by the agent, so trimming older turns does not lose workspace grounding.
 *
 * @param messages - The full session message array.
 * @param maxNonSystemMessages - How many of the most-recent non-system messages to keep. Defaults to 10.
 * @returns A new array: the system message (if any) followed by the last `maxNonSystemMessages` non-system messages.
 */
export function buildMessagesForModel(
  messages: ChatMessage[],
  maxNonSystemMessages = 10
): ChatMessage[] {
  const systemMessage =
    messages.length > 0 && messages[0].role === "system"
      ? messages[0]
      : undefined;

  // Non-system messages start at index 1 when a system message is present,
  // otherwise the entire array is non-system messages.
  const nonSystemMessages = systemMessage ? messages.slice(1) : messages;

  // Keep only the tail of the conversation to control prompt size.
  const trimmed = nonSystemMessages.slice(-maxNonSystemMessages);

  return systemMessage ? [systemMessage, ...trimmed] : trimmed;
}
