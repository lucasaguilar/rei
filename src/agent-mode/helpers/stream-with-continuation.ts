import type { ChatSession } from "../../chat/types.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { AgentLogger } from "../../core/logger.js";
import { cleanResponseForHistory } from "../../core/helpers/turn-message.helpers.js";
import { streamTurnWithInterception } from "./token-streamer.js";

/** Max consecutive truncation continuations before giving up. */
export const MAX_TRUNCATION_CONTINUATIONS = 3;

/** Injected when the model's previous response was cut off by the token limit. */
export const TRUNCATION_CONTINUATION =
  "Your previous response was cut off by the output token limit. " +
  "Continue EXACTLY from where you left off — do NOT repeat, summarize, or restart. " +
  "Just continue the text as one uninterrupted response.";

/**
 * Streams one model turn, auto-continuing when the model hits the output-token limit mid-response.
 * Each continuation appends the partial output + a "keep going" nudge ONLY for the follow-up call,
 * then strips those scratch messages so the caller's history stays clean — so on return the
 * conversation is unchanged and `rawResponse` holds the full (re-joined) text. Shared by both XML
 * agent paths (`executeAgentTurn` + `executeAgentTurnWholefile`). Extracted from generator.ts
 * (Phase 3) — identical logic was duplicated in both.
 */
export async function streamWithContinuation(params: {
  provider: ModelProvider;
  messages: ChatSession["messages"];
  modelOverride?: string;
  onChunk?: (event: {
    type: "thinking" | "text" | "status";
    content: string;
  }) => void;
  logger: AgentLogger;
  /** Running count for this turn (reset per turn; bounds continuations within a single turn). */
  truncationCount: number;
}): Promise<{ rawResponse: string; truncationCount: number }> {
  const { provider, modelOverride, onChunk, logger } = params;
  let truncationCount = params.truncationCount;
  // Scratch copy: continuations are appended here for the follow-up call and sliced back off, so
  // the caller's `messages` reference is never mutated (mirrors the original in-place reset).
  let messages = params.messages;

  let finishReason = "stop";
  let rawResponse = await streamTurnWithInterception({
    provider,
    messages,
    model: modelOverride,
    onChunk,
    onFinish: (r) => {
      finishReason = r;
    },
  });

  while (
    finishReason === "length" &&
    truncationCount < MAX_TRUNCATION_CONTINUATIONS
  ) {
    truncationCount++;
    logger.logInfo(
      `[truncation] Response cut off (attempt ${truncationCount}/${MAX_TRUNCATION_CONTINUATIONS}), continuing...`,
    );
    messages = [
      ...messages,
      { role: "assistant", content: cleanResponseForHistory(rawResponse) },
      { role: "user", content: TRUNCATION_CONTINUATION },
    ];
    finishReason = "stop";
    const continuation = await streamTurnWithInterception({
      provider,
      messages,
      model: modelOverride,
      onChunk,
      onFinish: (r) => {
        finishReason = r;
      },
    });
    rawResponse = rawResponse + continuation;
    // Remove the continuation messages we injected (keep history clean)
    messages = messages.slice(0, messages.length - 2);
  }

  return { rawResponse, truncationCount };
}
