import { lightweightCompress } from "./helpers/chat.helpers.js";
import { compressSkeletonMap } from "./helpers/compression.js";
import type { AgentEditFormat } from "../prompts/prompt-builder.js";
import type { ChatMessage, SessionMode } from "./types.js";

function isEnrichedTurnMessage(content: string): boolean {
  return content.includes("Task:") && content.includes("Repository summary:");
}

function compactHistoricalUserTurn(message: ChatMessage): ChatMessage {
  const taskMatch = message.content.match(/^Task:\s*(.+)$/m);
  const task = taskMatch?.[1]?.trim();
  if (!task) {
    return { ...message, content: "[Previous turn context omitted]" };
  }

  return {
    ...message,
    content: `Previous user request: ${task}`,
  };
}

// NOTE: Position 0 in session.messages is always the system message and is
// never included in this count — it is always prepended to the output.
// Each user message already re-injects workspace context (files, RAG, AST),
// so trimming old turns only loses conversational back-and-forth, not code grounding.
const MAX_NON_SYSTEM_MESSAGES: Record<SessionMode, number> = {
  ask: 20, // ~40 full exchanges
  planning: 12, // ~24 full exchanges
  agent: 16, // ~32 full exchanges
};

const AGENT_ACTION_TAG_PATTERN = /<(wholefile|edit|request_files|create)\b/;

/**
 * Returns true if an assistant message belongs to a non-agent mode (e.g. ask/planning).
 * These messages use prose format ("Direct Answer", plain text) and pollute agent-mode
 * context by making small models pattern-match to the wrong output format.
 *
 * Planning responses are preserved regardless: they contain structured implementation
 * plans that the agent should read and execute, not discard.
 */
function isNonAgentAssistantMessage(message: ChatMessage): boolean {
  // Preserve planning responses — they are structured plans for the agent to follow.
  if (message.sourceMode === "planning") return false;

  return (
    message.role === "assistant" &&
    !AGENT_ACTION_TAG_PATTERN.test(message.content)
  );
}

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
  mode: SessionMode = "ask",
  editFormat?: AgentEditFormat,
): ChatMessage[] {
  const systemMessage =
    messages.length > 0 && messages[0].role === "system"
      ? messages[0]
      : undefined;

  // Non-system messages start at index 1 when a system message is present,
  // otherwise the entire array is non-system messages.
  const nonSystemMessages = systemMessage ? messages.slice(1) : messages;

  // Drop empty assistant placeholders so they don't waste context window.
  const cleanedNonSystemMessages = nonSystemMessages.filter(
    (message) => !(message.role === "assistant" && !message.content.trim()),
  );

  // Legacy sessions may persist full enriched context in user turns.
  // Keep the latest user turn intact and compact older enriched turns.
  let latestUserIndex = -1;
  for (
    let index = cleanedNonSystemMessages.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (cleanedNonSystemMessages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  const normalizedNonSystemMessages = cleanedNonSystemMessages.map(
    (message, index) => {
      if (
        message.role === "user" &&
        index !== latestUserIndex &&
        isEnrichedTurnMessage(message.content)
      ) {
        return compactHistoricalUserTurn(message);
      }

      return message;
    },
  );

  // Keep only the tail of the conversation to control prompt size.
  const maxNonSystemMessages = MAX_NON_SYSTEM_MESSAGES[mode];
  const trimmed = normalizedNonSystemMessages.slice(-maxNonSystemMessages);

  // In agent mode, compact old assistant messages that have no XML action tags.
  // These come from ask/planning turns and contain "Direct Answer" / prose format
  // which causes small models to pattern-match to the wrong output format.
  const modeNormalized =
    mode === "agent"
      ? trimmed.map((message) =>
          isNonAgentAssistantMessage(message)
            ? { ...message, content: "[Previous response — different mode]" }
            : message,
        )
      : trimmed;

  // Aider-style system_reminder: append a format reminder to the LAST user message
  // in agent mode. Small models have recency bias — instructions near the generation
  // point outweigh the system prompt at position 0 as context grows.
  const withReminder =
    mode === "agent" && editFormat
      ? appendAgentReminder(modeNormalized, editFormat)
      : modeNormalized;

  return systemMessage ? [systemMessage, ...withReminder] : withReminder;
}

const AGENT_REMINDER_BY_FORMAT: Record<AgentEditFormat, string> = {
  wholefile:
    '\n\n---\nREMINDER: You are in agent mode. ALL file changes MUST use `<wholefile path="...">complete file</wholefile>` blocks. Do NOT use plain text descriptions, "Direct Answer", or any other format.',
  sr: '\n\n---\nREMINDER: You are in agent mode. ALL file changes MUST use `<edit>` or `<create>` XML blocks. Do NOT use plain text descriptions, "Direct Answer", or any other format.',
};

function appendAgentReminder(
  messages: ChatMessage[],
  editFormat: AgentEditFormat,
): ChatMessage[] {
  const reminder = AGENT_REMINDER_BY_FORMAT[editFormat];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const updated = [...messages];
      updated[i] = {
        ...messages[i],
        content: messages[i].content + reminder,
      };
      return updated;
    }
  }
  return messages;
}
