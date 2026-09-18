import type { TokenUsage } from "./model-provider.js";

/** Raw usage block as the OpenAI-compat API reports it (non-stream response or final stream chunk). */
export interface RawOpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Maps a backend-reported usage block to REI's TokenUsage, dropping anything that isn't a
 * usable count (negative / non-finite). Returns {} when the backend reported nothing valid —
 * callers treat that as "no usage" and fall back to estimation.
 */
export function sanitizeOpenAIUsage(raw?: RawOpenAIUsage): TokenUsage {
  const usage: TokenUsage = {};
  if (typeof raw?.prompt_tokens === "number" && Number.isFinite(raw.prompt_tokens) && raw.prompt_tokens >= 0) {
    usage.promptTokens = raw.prompt_tokens;
  }
  if (typeof raw?.completion_tokens === "number" && Number.isFinite(raw.completion_tokens) && raw.completion_tokens >= 0) {
    usage.completionTokens = raw.completion_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : {};
}

/**
 * Aggregates per-call TokenUsage across a turn (the tools loop makes one model call per
 * iteration). promptTokens takes the MAX across calls — the peak, which is what the "in" figure
 * reports: how big the prompt actually got. completionTokens SUMS — every call generated tokens
 * (content + reasoning + tool-call JSON), all of which were decoded.
 *
 * `lastPromptTokens` tracks the most recent call instead, because the MAX is the wrong number for
 * the context gauge the moment a turn COMPACTS: the history is cut in half, every later call
 * reports the smaller prompt, and the max keeps reporting the peak — so the bar went on showing
 * the pre-compaction figure and the compaction looked like it had done nothing.
 */
export function mergeTurnUsage(
  current: TokenUsage | undefined,
  next?: TokenUsage,
): TokenUsage {
  if (!next) return current ?? {};
  const promptTokens = Math.max(current?.promptTokens ?? 0, next.promptTokens ?? 0);
  const completionTokens = (current?.completionTokens ?? 0) + (next.completionTokens ?? 0);
  // A call that reported no prompt count leaves the previous "current" reading standing, rather
  // than resetting the gauge to zero on one silent response.
  const lastPromptTokens = next.promptTokens ?? current?.lastPromptTokens;
  return { promptTokens, completionTokens, lastPromptTokens };
}
