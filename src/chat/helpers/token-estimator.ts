/**
 * Estimates the number of tokens in a given text.
 * Uses an empirical approximation of 3.7 characters per token,
 * which balances prose (approx. 4 chars/token) and source code (approx. 3.2 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.7);
}

/**
 * Estimates the total tokens for an array of chat messages.
 */
export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((acc, msg) => acc + estimateTokens(msg.content), 0);
}
