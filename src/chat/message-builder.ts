import { lightweightCompress } from "./helpers/chat.helpers.js";
import { compressSkeletonMap } from "./helpers/compression.js";
import type { AgentEditFormat } from "../prompts/prompt-builder.js";
import type { ChatMessage, SessionMode } from "./types.js";
import { estimateTokens } from "./helpers/token-estimator.js";
import {
  getContextWindow,
  getMaxOutputTokens,
} from "../config/model-runtime.js";

/**
 * Tool plumbing: a `tool` result is addressed by its `tool_call_id`, and an assistant message that
 * carries `tool_calls` is answered by the results that follow it. Neither may be merged into a
 * neighbour the way two consecutive prose messages can — concatenating them loses the id pairing
 * and produces a sequence the provider rejects.
 *
 * Only reachable since the turn's tool traffic started living in the session history (before that
 * the loop kept it to itself and the history never held a `tool` message).
 */
function isToolPlumbing(message: ChatMessage): boolean {
  return (
    message.role === "tool" ||
    (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0)
  );
}

function isEnrichedTurnMessage(content: string): boolean {
  return content.includes("Task:") && content.includes("Repository summary:");
}

/**
 * The bulky per-turn sections. Only a message carrying one of these is worth rewriting.
 *
 * Rewriting ANY historical message costs a full re-prefill: the backend caches the KV of the last
 * prompt and reuses it only while the next prompt extends it byte for byte. Measured on oMLX with
 * ~27.5k tokens — prefix preserved 0.73s, prefix broken 61.11s. So stripping a stale repo map from
 * an old turn pays (tens of thousands of tokens saved); stripping a two-line header does not.
 *
 * On-demand file context — the default for every mode — never injects either section, so in the
 * normal configuration nothing is rewritten and the prefix survives the whole session.
 */
const HEAVY_TURN_SECTIONS = /### (?:RELEVANT REPOSITORY SKELETON MAP|PROJECT FILE TREE)/;

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

// How many of the most-recent assistant turns to keep VERBATIM. Older prose answers are
// demoted to a one-line gist (see demoteOldAssistantProse). Configurable so power users can
// trade continuity for context budget; default 3 keeps the last few exchanges intact.



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
/**
 * Trims one message to fit a token budget, keeping the head AND the tail.
 *
 * The interesting part of a long file or a build log is at both ends — the imports and the error —
 * so a middle-out cut preserves more meaning than a head cut, and the marker says how much went.
 */
function clampToBudget(msg: ChatMessage, budgetTokens: number): ChatMessage {
  const maxChars = Math.max(2000, budgetTokens * 4);
  if (!msg.content || msg.content.length <= maxChars) return msg;
  const half = Math.floor(maxChars / 2);
  const dropped = msg.content.length - maxChars;
  return {
    ...msg,
    content:
      msg.content.slice(0, half) +
      `\n\n… [${dropped.toLocaleString("en-US")} characters trimmed to fit the context window] …\n\n` +
      msg.content.slice(-half),
  };
}

export function buildMessagesForModel(
  messages: ChatMessage[],
  mode: SessionMode = "ask",
  editFormat?: AgentEditFormat,
  /** Tokens the request costs BEFORE any message — the `tools` array. The system prompt is counted
   *  from `messages[0]`; the tools schema is not visible here, so the caller measures it. */
  toolsOverheadTokens = 0,
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
  // An assistant message carrying tool_calls is NOT an empty placeholder even when its content is
  // empty — that is the normal shape when the model only asks for tools. Dropping it orphans the
  // results that answer it, which the provider rejects. Only reachable since the turn's tool
  // traffic began living in the history.
  const cleanedNonSystemMessages = nonSystemMessages.filter(
    (message) =>
      !message.pruned &&
      !(
        message.role === "assistant" &&
        !message.content.trim() &&
        (message.tool_calls?.length ?? 0) === 0
      ),
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
        isEnrichedTurnMessage(message.content) &&
        HEAVY_TURN_SECTIONS.test(message.content)
      ) {
        return compactHistoricalUserTurn(message);
      }

      return message;
    },
  );

  // History is passed through as it stands. Demoting old assistant answers to a headline used to
  // happen here, and it was the last thing rewriting the prompt mid-conversation.
  //
  // Measured on a real session: it demoted 3 answers and saved 7,455 chars (~1,864 tokens, 5% of
  // the prompt) — while the tool traffic it does not touch accounted for 80%. The rewrite cost 132
  // seconds of re-prefill, because a local backend reuses its KV cache only while each prompt
  // extends the last. Shrinking history is the compactor's job (needsCompaction, by threshold),
  // where a cold prefill is paid once instead of on the turn that happens to cross a boundary.
  const tieredNonSystemMessages = normalizedNonSystemMessages;

  // Keep the tail of the conversation under a token budget that SCALES WITH the context
  // window (was a hardcoded 18000 that silently dropped older history on large-window cloud /
  // big-local models → "I don't remember what we were doing"). Reserve room for output;
  // when the window is unknown (0 = no-trim, e.g. cloud) keep a large amount.
  const ctxWindow = getContextWindow();
  // The budget must pay for everything the request carries, not just the history. The system prompt
  // and the tools schema are ~5.6k tokens in agent mode and were counted by nobody, so a session
  // that fit "on budget" still went over the window — measured at 37,472 sent against a 32,768
  // window, with the trimmer reporting itself within budget.
  const systemTokens = systemMessage ? estimateTokens(systemMessage.content) : 0;
  const fixedOverhead = systemTokens + toolsOverheadTokens;
  const MAX_TOKEN_BUDGET =
    ctxWindow > 0
      ? Math.max(
          2000,
          Math.floor((ctxWindow - getMaxOutputTokens() - fixedOverhead) * 0.85),
        )
      : 100000;
  let accumulatedTokens = 0;
  const budgetedMessages: ChatMessage[] = [];

  // The latest message is always kept — it is the current turn. But it is no longer kept WHOLE at
  // any size: in agent mode each tool result becomes a message, so one `read_files` of a large file
  // could exceed the whole budget by itself and sail through unchecked. It is clamped instead, with
  // the cut announced so the model knows something is missing rather than reasoning over a
  // silently-truncated file.
  if (tieredNonSystemMessages.length > 0) {
    const latestMsg = clampToBudget(
      tieredNonSystemMessages[tieredNonSystemMessages.length - 1],
      MAX_TOKEN_BUDGET,
    );
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

  // The trim walks backwards and stops on a token budget, so it can cut BETWEEN an assistant that
  // requested tools and the results answering it. A `tool` message left at the head of the window
  // has no parent in the window: providers reject it ("tool message without preceding tool_calls").
  // Dropping the orphans is the only safe repair — the results are meaningless without the request.
  const dropOrphanToolHead = (msgs: ChatMessage[]): ChatMessage[] => {
    let start = 0;
    while (start < msgs.length && msgs[start].role === "tool") start += 1;
    return start === 0 ? msgs : msgs.slice(start);
  };

  const finalNonSystem = dropOrphanToolHead(
    budgetedMessages.length > 0 ? budgetedMessages : tieredNonSystemMessages,
  );

  const modeNormalized = finalNonSystem;

  // No format reminder is injected any more. The XML `<edit>`/`<wholefile>` reminder that used to
  // ride inside the stored user message was removed: it contradicted the native tool-calling
  // system prompt (which forbids XML tags) and pointed the model at a path the runtime no longer
  // parses. The system prompt + native tools are the single source of truth for how edits are made.

  // Enforce strict role alternation and ensure conversation starts with 'user'
  const alternating: ChatMessage[] = [];
  for (const msg of modeNormalized) {
    if (alternating.length === 0) {
      if (msg.role === "assistant") {
        alternating.push({ role: "user", content: "Initialize conversation." });
      }
      alternating.push({ ...msg });
    } else {
      const last = alternating[alternating.length - 1];
      if (last.role === msg.role && !isToolPlumbing(last) && !isToolPlumbing(msg)) {
        last.content += "\n\n" + msg.content;
      } else {
        alternating.push({ ...msg });
      }
    }
  }

  return systemMessage ? [systemMessage, ...alternating] : alternating;
}

