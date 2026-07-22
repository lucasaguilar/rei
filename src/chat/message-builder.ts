import { lightweightCompress } from "./helpers/chat.helpers.js";
import { compressSkeletonMap } from "./helpers/compression.js";
import type { AgentEditFormat } from "../prompts/prompt-builder.js";
import type { ChatMessage, SessionMode } from "./types.js";
import { estimateTokens } from "./helpers/token-estimator.js";
import {
  getContextWindow,
  getMaxOutputTokens,
} from "../config/model-runtime.js";

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

// How many of the most-recent assistant turns to keep VERBATIM. Older prose answers are
// demoted to a one-line gist (see demoteOldAssistantProse). Configurable so power users can
// trade continuity for context budget; default 3 keeps the last few exchanges intact.
function verbatimAssistantTurns(): number {
  const raw = Number(process.env.REI_VERBATIM_HISTORY_TURNS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
}

/**
 * Collapse a verbose historical assistant answer down to a compact gist. In a coding agent the
 * durable state is the workspace (files on disk, re-read on demand) plus the DECISIONS — not the
 * assistant's expository prose. Re-sending a 1700-token analysis from an unrelated earlier task
 * every turn is near-pure waste. We keep the headline (or first non-empty line) as an anchor so a
 * later "as I said before" reference still resolves. The FULL text stays in session.messages
 * (persistence / user scrollback) — only what we send to the model shrinks.
 */
function demoteAssistantProse(message: ChatMessage): ChatMessage {
  const lines = message.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Already short — demoting saves nothing and would only lose fidelity.
  if (lines.length <= 2) return message;

  const headline =
    lines.find((line) => /^#{1,6}\s+/.test(line))?.replace(/^#{1,6}\s+/, "") ??
    lines[0];
  const gist = headline.length > 200 ? `${headline.slice(0, 197)}…` : headline;
  return { ...message, content: `[Earlier answer — gist] ${gist}` };
}

/**
 * Recency-tiered history: keep the last `verbatimTurns` assistant answers intact, and demote
 * OLDER prose answers to a gist. Two carve-outs are preserved verbatim regardless of age because
 * they carry durable, non-expository value:
 *   - agent action messages (edits/creates/requests) — the record of what was done, and
 *   - planning-sourced plans — structured plans the agent is meant to read and execute.
 * User and system messages are untouched (user turns already re-inject workspace grounding).
 */
function demoteOldAssistantProse(
  messages: ChatMessage[],
  verbatimTurns: number,
): ChatMessage[] {
  let assistantSeen = 0;
  const result = messages.slice();
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const message = result[i];
    if (message.role !== "assistant") continue;
    assistantSeen += 1;
    const isRecent = assistantSeen <= verbatimTurns;
    const isAction = AGENT_ACTION_TAG_PATTERN.test(message.content);
    const isPlan = message.sourceMode === "planning";
    if (!isRecent && !isAction && !isPlan) {
      result[i] = demoteAssistantProse(message);
    }
  }
  return result;
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

  // Drop empty assistant placeholders (waste context), and turns pruned as off-topic detours via
  // `/tree prune` (kept on disk, excluded here). Whole turns are pruned together so removing them
  // leaves user/assistant/tool pairing intact. See docs/context-drift-spec.md.
  const cleanedNonSystemMessages = nonSystemMessages.filter(
    (message) =>
      !message.pruned &&
      !(message.role === "assistant" && !message.content.trim()),
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

  // Recency-tiered demotion: the last few assistant answers stay verbatim; older prose answers
  // collapse to a gist so re-sending stale ask/planning essays doesn't burn context every turn.
  // Runs BEFORE the budget accounting so the freed room lets more RECENT history survive the trim.
  const tieredNonSystemMessages = demoteOldAssistantProse(
    normalizedNonSystemMessages,
    verbatimAssistantTurns(),
  );

  // Keep the tail of the conversation under a token budget that SCALES WITH the context
  // window (was a hardcoded 18000 that silently dropped older history on large-window cloud /
  // big-local models → "I don't remember what we were doing"). Reserve room for output;
  // when the window is unknown (0 = no-trim, e.g. cloud) keep a large amount.
  const ctxWindow = getContextWindow();
  const MAX_TOKEN_BUDGET =
    ctxWindow > 0
      ? Math.max(8000, Math.floor((ctxWindow - getMaxOutputTokens()) * 0.85))
      : 100000;
  let accumulatedTokens = 0;
  const budgetedMessages: ChatMessage[] = [];

  // We always want to keep the latest message (which is the current user prompt)
  if (tieredNonSystemMessages.length > 0) {
    const latestMsg =
      tieredNonSystemMessages[tieredNonSystemMessages.length - 1];
    budgetedMessages.unshift(latestMsg);
    accumulatedTokens += estimateTokens(latestMsg.content);

    // Going backwards from the second-to-last message
    for (let i = tieredNonSystemMessages.length - 2; i >= 0; i--) {
      const msg = tieredNonSystemMessages[i];
      const tokens = estimateTokens(msg.content);
      if (accumulatedTokens + tokens > MAX_TOKEN_BUDGET) {
        break; // Stop including older history to fit context window
      }
      budgetedMessages.unshift(msg);
      accumulatedTokens += tokens;
    }
  }

  const finalNonSystem =
    budgetedMessages.length > 0
      ? budgetedMessages
      : tieredNonSystemMessages;

  const modeNormalized = finalNonSystem;

  // Aider-style system_reminder: append a format reminder to the LAST user message
  // in agent mode. Small models have recency bias — instructions near the generation
  // point outweigh the system prompt at position 0 as context grows.
  const withReminder =
    mode === "agent" && editFormat
      ? appendAgentReminder(modeNormalized, editFormat)
      : modeNormalized;

  // Enforce strict role alternation and ensure conversation starts with 'user'
  const alternating: ChatMessage[] = [];
  for (const msg of withReminder) {
    if (alternating.length === 0) {
      if (msg.role === "assistant") {
        alternating.push({ role: "user", content: "Initialize conversation." });
      }
      alternating.push({ ...msg });
    } else {
      const last = alternating[alternating.length - 1];
      if (last.role === msg.role) {
        last.content += "\n\n" + msg.content;
      } else {
        alternating.push({ ...msg });
      }
    }
  }

  return systemMessage ? [systemMessage, ...alternating] : alternating;
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
