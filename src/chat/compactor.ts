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

/**
 * How long to wait for a summary, scaled to how much there is to read.
 *
 * A flat 60s was a cloud-era number. Summarizing a real local session means prefilling the whole
 * history first, and prefill on this class of hardware runs at a few hundred tokens/second —
 * measured 176s for 55k tokens. So the one compaction that matters, the one on a session big enough
 * to need it, was the one guaranteed to be cut off: the call died at 60s, the error was swallowed,
 * and the history came back untouched.
 *
 * 150 tok/s is a deliberately pessimistic floor (measured ~300-390), so a slower machine or a
 * loaded GPU still finishes. The 30s base covers the request itself; the cap keeps a wedged backend
 * from blocking a turn forever. `COMPACTOR_TIMEOUT_MS` overrides the whole calculation.
 */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_TOKENS_PER_SECOND = 150;
const TIMEOUT_CAP_MS = 900_000; // 15 min — past this, something is wrong, not slow

export function compactorTimeoutMs(promptChars = 0): number {
  const override = Number(process.env.COMPACTOR_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  const tokens = promptChars / 4; // the same chars/4 estimate used everywhere else
  const scaled = TIMEOUT_BASE_MS + (tokens / TIMEOUT_TOKENS_PER_SECOND) * 1000;
  return Math.min(Math.round(scaled), TIMEOUT_CAP_MS);
}

/**
 * Which model summarizes: `COMPACTOR_MODEL` when set, else the model the session is ALREADY running
 * on.
 *
 * It used to fall back to the provider's own default, which is `<PREFIX>_MODEL` — the ask/planning
 * model, not the agent's and not one picked with `/model`. On a local backend that means loading a
 * SECOND model to summarize: minutes of swap, memory pressure, and a 404 when the id belongs to a
 * different backend (a real case: COMPACTOR_MODEL=qwen/qwen3-4b, an LM Studio name, against oMLX).
 * Reusing the loaded model costs nothing to start and keeps its cached prefix warm.
 */
export function compactorModelFor(activeModel?: string): string | undefined {
  return process.env.COMPACTOR_MODEL?.trim() || activeModel || undefined;
}

/**
 * The outcome of a compaction attempt.
 *
 * `skipped` carries WHY the history came back unchanged. Compaction fails softly on purpose — a
 * failed summary must never kill the turn — but "softly" used to mean "silently": `/compact`
 * reported success, named the model that had just 404'd, and printed `117 → 117 messages` without
 * noticing that the count had not moved. The caller cannot tell the difference from the messages
 * alone, so the reason travels with them.
 */
export interface CompactionResult {
  messages: ChatMessage[];
  /** Set when nothing was compacted; the reason, phrased for the user. */
  skipped?: string;
  /**
   * The model that actually WROTE the summary — which is not always the one asked for. When a
   * configured COMPACTOR_MODEL fails, the call is retried with the provider's own model, and
   * reporting the requested name then credits the summary to a model that 404'd.
   */
  model?: string;
}

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
}): Promise<CompactionResult> {
  const { messages, provider, modelOverride, force } = params;

  const systemMessage =
    messages.length > 0 && messages[0].role === "system"
      ? messages[0]
      : undefined;
  const nonSystem = systemMessage ? messages.slice(1) : messages;

  // Gate on the same window-aware check as auto-compaction (manual /compact passes force).
  if (!force && !needsCompaction(messages)) {
    return { messages, skipped: "the history is still under the compaction threshold" };
  }

  // Nothing to summarize when the session is empty or has only 1 message
  if (nonSystem.length < 2) {
    return { messages, skipped: "there is not enough conversation to summarize yet" };
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
    // The timeout is sized from what the summarizer actually has to read.
    const timeout = compactorTimeoutMs(
      sumMessages.reduce((n, m) => n + m.content.length, 0),
    );
    let summarizedBy = modelOverride;
    if (modelOverride) {
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
        summarizedBy = provider.getModel?.();
      }
    } else {
      // No model to name (nothing configured and no active model known): let the provider pick,
      // still bounded — the same scaled timeout, since the work is the same.
      summary = await withTimeout(provider.completeChat(sumMessages, {}), timeout);
      summarizedBy = provider.getModel?.();
    }

    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[CONVERSATION SUMMARY — DO NOT SUMMARIZE AGAIN]\n\n${summary}`,
    };

    return {
      messages: systemMessage
        ? [systemMessage, summaryMessage, ...verbatim]
        : [summaryMessage, ...verbatim],
      model: summarizedBy,
    };
  } catch (error) {
    // Non-fatal: keep the full history (uncompacted) so the turn proceeds. Log a single
    // clean line — never dump the raw error/stack, which would corrupt the live TUI.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[COMPACTOR] Skipped — keeping full history: ${reason}`);
    return { messages, skipped: reason };
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
