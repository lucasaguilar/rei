import type { ChatMessage, SessionMode } from "./types.js";

// NOTE: Position 0 in session.messages is always the system message and is
// never included in this count — it is always prepended to the output.
// Each user message already re-injects workspace context (files, RAG, AST),
// so trimming old turns only loses conversational back-and-forth, not code grounding.
const MAX_NON_SYSTEM_MESSAGES: Record<SessionMode, number> = {
  ask: 14,       // ~7 full exchanges
  planning: 10,  // ~5 full exchanges
  agent: 10,     // ~5 full exchanges — was 5, too short for multi-step tasks
};

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
 * @param mode - The active session mode; controls how many history turns to keep.
 * @returns A new array: the system message (if any) followed by the last N non-system messages.
 */
export function buildMessagesForModel(
  messages: ChatMessage[],
  mode: SessionMode = "ask"
): ChatMessage[] {
  const systemMessage =
    messages.length > 0 && messages[0].role === "system"
      ? messages[0]
      : undefined;

  // Non-system messages start at index 1 when a system message is present,
  // otherwise the entire array is non-system messages.
  const nonSystemMessages = systemMessage ? messages.slice(1) : messages;

  // Keep only the tail of the conversation to control prompt size.
  const maxNonSystemMessages = MAX_NON_SYSTEM_MESSAGES[mode];
  const trimmed = nonSystemMessages.slice(-maxNonSystemMessages);

  return systemMessage ? [systemMessage, ...trimmed] : trimmed;
}
