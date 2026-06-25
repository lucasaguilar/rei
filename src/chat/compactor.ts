import type { ChatMessage, SessionMode } from './types.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { getContextWindow, getMaxOutputTokens } from '../config/model-runtime.js';
import { estimateTokens } from './helpers/token-estimator.js';

const VERBATIM_KEEP = 8;      // Number of recent non-system messages to keep verbatim
// Compaction triggers when the conversation grows large RELATIVE TO the context window —
// NOT at a fixed message count. A fixed count (was 20) summarized work prematurely on
// large-window models (cloud 128K, or big local), losing recall ("I don't remember what we
// were doing"). Now it scales: small local windows compact sooner, cloud almost never.
const COMPACT_TOKEN_FRACTION = 0.65; // compact once history > 65% of the usable window
const COMPACT_MIN_MSGS = 12;         // never compact a small conversation
const COMPACT_MSG_HARD_CAP = 80;     // safety net when the window is unknown (0 = no-trim)

const COMPACTION_PROMPT = `Summarize this conversation for a coding agent's persistent memory. 
Focus on:
- Technical decisions made
- Files modified or planned to be modified
- Bugs found or fixed
- Pending or open questions
Keep it concise (under 400 words). Use bullet points. 
Do NOT include full code blocks unless absolutely essential (e.g. a small config change).
Format the summary as a single "assistant" message content.`;

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

  const systemMessage = messages.length > 0 && messages[0].role === "system" ? messages[0] : undefined;
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
    { role: "user", content: "Summarize the conversation above now." }
  ];

  try {
    let summary: string;
    try {
      summary = await provider.completeChat(sumMessages, { model: modelOverride });
    } catch (err) {
      // COMPACTOR_MODEL may be invalid for the ACTIVE provider (e.g. an Ollama-style tag
      // like "qwen3:4b" while running on LM Studio → "No models loaded"). Fall back to the
      // provider's default model before giving up, so a bad override doesn't break compaction.
      if (!modelOverride) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[COMPACTOR] COMPACTOR_MODEL="${modelOverride}" failed (${reason}); retrying with the provider's default model.`,
      );
      summary = await provider.completeChat(sumMessages, {});
    }

    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[CONVERSATION SUMMARY — DO NOT SUMMARIZE AGAIN]\n\n${summary}`
    };

    return systemMessage ? [systemMessage, summaryMessage, ...verbatim] : [summaryMessage, ...verbatim];
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
export function needsCompaction(messages: ChatMessage[]): boolean {
  const nonSystem = messages.filter(m => m.role !== 'system');
  if (nonSystem.length <= COMPACT_MIN_MSGS) return false;

  const window = getContextWindow();
  if (window <= 0) {
    // Unknown / no-trim window (e.g. cloud with REI_CONTEXT_WINDOW unset): don't summarize
    // by tokens — only the hard message cap guards against unbounded growth.
    return nonSystem.length > COMPACT_MSG_HARD_CAP;
  }
  const tokens = estimateTokens(messages.map(m => m.content).join('\n'));
  const usable = Math.max(1, window - getMaxOutputTokens());
  return tokens > usable * COMPACT_TOKEN_FRACTION;
}
