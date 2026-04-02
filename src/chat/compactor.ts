import type { ChatMessage, SessionMode } from './types.js';
import type { ModelProvider } from '../providers/model-provider.js';

const COMPACT_THRESHOLD = 20; // Number of non-system messages before auto-compacting
const VERBATIM_KEEP = 8;      // Number of recent non-system messages to keep verbatim

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
 */
export async function compactSession(params: {
  messages: ChatMessage[];
  provider: ModelProvider;
  modelOverride?: string;
}): Promise<ChatMessage[]> {
  const { messages, provider, modelOverride } = params;

  const systemMessage = messages.length > 0 && messages[0].role === "system" ? messages[0] : undefined;
  const nonSystem = systemMessage ? messages.slice(1) : messages;

  if (nonSystem.length <= COMPACT_THRESHOLD) {
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
    const summary = await provider.completeChat(sumMessages, { model: modelOverride });
    
    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[CONVERSATION SUMMARY — DO NOT SUMMARIZE AGAIN]\n\n${summary}`
    };

    return systemMessage ? [systemMessage, summaryMessage, ...verbatim] : [summaryMessage, ...verbatim];
  } catch (error) {
    // If summarization fails, keep the original messages to avoid data loss
    console.warn("[COMPACTOR] Failed to generate summary:", error);
    return messages;
  }
}

/**
 * Checks if a session needs compacting.
 */
export function needsCompaction(messages: ChatMessage[]): boolean {
  const nonSystem = messages.filter(m => m.role !== 'system');
  return nonSystem.length > COMPACT_THRESHOLD;
}
