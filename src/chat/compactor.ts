import type { ChatMessage } from "./types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import {
  getContextWindow,
  getMaxOutputTokens,
} from "../config/model-runtime.js";
import { estimateTokens } from "./helpers/token-estimator.js";

const VERBATIM_KEEP = 8; // Number of recent non-system messages to keep verbatim
// Compaction triggers when the conversation grows large RELATIVE TO the context window —
// NOT at a fixed message count. A fixed count (was 20) summarized work prematurely on
// large-window models (cloud 128K, or big local), losing recall ("I don't remember what we
// were doing"). Now it scales: small local windows compact sooner, cloud almost never.
const COMPACT_TOKEN_FRACTION = 0.65; // compact once history > 65% of the usable window
const COMPACT_MIN_MSGS = 12; // never compact a small conversation
const COMPACT_MSG_HARD_CAP = 80; // safety net when the window is unknown (0 = no-trim)

const COMPACTION_PROMPT = `Summarize this conversation for a coding agent's persistent memory. 
Focus on:
- Technical decisions made
- Files modified or planned to be modified
- Bugs found or fixed
- Pending or open questions
Keep it concise (under 400 words). Use bullet points. 
Do NOT include full code blocks unless absolutely essential (e.g. a small config change).
Format the summary as a single "assistant" message content.`;

/** Wraps a promise with a timeout. Rejects with an Error when `ms` elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // Both branches resolve (never reject) so fake-timer test runners don't flag
  // the losing side as an unhandled rejection.
  const timeoutSignal = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  const wrapped = promise.then(
    (v: T) => ({ ok: true as const, value: v }),
    (e: unknown) => ({ ok: false as const, error: e }),
  );
  const timeoutResult = timeoutSignal.then(
    () =>
      ({ ok: false as const, error: new Error(`Timeout after ${ms}ms`) }) as {
        ok: false;
        error: unknown;
      },
  );
  return Promise.race([wrapped, timeoutResult])
    .finally(() => clearTimeout(timer))
    .then((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });
}

/** Default compaction timeout — overridden by COMPACTOR_TIMEOUT_MS env var. */
const compactorTimeoutMs = (): number => {
  const val = process.env.COMPACTOR_TIMEOUT_MS;
  return val ? Number(val) : 60_000;
};

/**
 * Summarizes the conversation using a cheaper model if configured.
 * Replaces older messages with a summary, keeping the most recent turns verbatim.
 *
 * @param force - When true, bypasses the needsCompaction check (used for manual /compact).
 */
export async function compactSession(params: {
  messages: ChatMessage[];
  provider: ModelProvider;
  modelOverride?: string;
  force?: boolean;
}): Promise<ChatMessage[]> {
  const { messages, provider, modelOverride, force } = params;

  const systemMessage =
    messages.length > 0 && messages[0].role === "system"
      ? messages[0]
      : undefined;
  const nonSystem = systemMessage ? messages.slice(1) : messages;

  // Gate on the same window-aware check as auto-compaction (manual /compact passes force).
  if (!force && !needsCompaction(messages)) {
    return messages;
  }

  // Nothing to summarize when the session is empty or has only 1 message
  if (nonSystem.length < 2) {
    return messages;
  }

  // Split into old (to be summarized) and new (to keep verbatim)
  const toSummarize = nonSystem.slice(0, -VERBATIM_KEEP);
  const verbatim = nonSystem.slice(-VERBATIM_KEEP);

  // Prepare summarization prompt
  const sumMessages: ChatMessage[] = [
    { role: "system", content: COMPACTION_PROMPT },
    ...toSummarize,
    { role: "user", content: "Summarize the conversation above now." },
  ];

  try {
    let summary: string;
    if (modelOverride) {
      const timeout = compactorTimeoutMs();
      try {
        summary = await withTimeout(
          provider.completeChat(sumMessages, { model: modelOverride }),
          timeout,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[COMPACTOR] COMPACTOR_MODEL="${modelOverride}" failed (${reason}); retrying with the provider's default model.`,
        );
        summary = await withTimeout(
          provider.completeChat(sumMessages, {}),
          timeout,
        );
      }
    } else {
      // No override: single call, no timeout (active model is already loaded).
      summary = await provider.completeChat(sumMessages, {});
    }

    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[CONVERSATION SUMMARY — DO NOT SUMMARIZE AGAIN]\n\n${summary}`,
    };

    return systemMessage
      ? [systemMessage, summaryMessage, ...verbatim]
      : [summaryMessage, ...verbatim];
  } catch (error) {
    // Non-fatal: keep the full history (uncompacted) so the turn proceeds. Log a single
    // clean line — never dump the raw error/stack, which would corrupt the live TUI.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[COMPACTOR] Skipped — keeping full history: ${reason}`);
    return messages;
  }
}

/**
 * Checks if a session needs compacting.
 */
export function needsCompaction(
  messages: ChatMessage[],
  /** Tokens the request costs before any message — system prompt and tools schema. Counting only
   *  the messages meant compaction waited for a threshold the request had already blown past. */
  fixedOverheadTokens = 0,
): boolean {
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= COMPACT_MIN_MSGS) return false;

  const window = getContextWindow();
  if (window <= 0) {
    // Unknown / no-trim window (e.g. cloud with REI_CONTEXT_WINDOW unset): don't summarize
    // by tokens — only the hard message cap guards against unbounded growth.
    return nonSystem.length > COMPACT_MSG_HARD_CAP;
  }
  const tokens =
    estimateTokens(messages.map((m) => m.content).join("\n")) + fixedOverheadTokens;
  const usable = Math.max(1, window - getMaxOutputTokens());
  return tokens > usable * COMPACT_TOKEN_FRACTION;
}
