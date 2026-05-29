/**
 * Utilities for detecting infinite loops and degenerate model responses.
 *
 * Degenerate output: the model repeats a short phrase many times ("I will be. I am. I was.")
 * Command loops: the model generates the exact same tool/command calls as the previous iteration.
 */

/**
 * Returns true when the text looks like degenerate model output — a short phrase
 * repeating 4+ times. Strips XML and think blocks before checking.
 */
export function isDegenerate(text: string): boolean {
  // Strip XML tags and thinking blocks for a clean check
  const clean = text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length < 80) return false;

  // Split into word-based chunks of 3–8 words and count duplicates
  const words = clean.split(" ").filter(Boolean);
  if (words.length < 12) return false;

  // Sliding window: check 4-word and 6-word n-grams for repetition
  for (const windowSize of [4, 6]) {
    const seen = new Map<string, number>();
    for (let i = 0; i <= words.length - windowSize; i++) {
      const gram = words.slice(i, i + windowSize).join(" ").toLowerCase();
      const count = (seen.get(gram) ?? 0) + 1;
      seen.set(gram, count);
      if (count >= 4) return true;
    }
  }

  return false;
}

/**
 * Builds a stable signature string from a list of commands/tool names for loop detection.
 * Sorting ensures order-independent comparison.
 */
export function buildCommandSignature(
  commands: string[],
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  fileRequests: string[],
): string {
  const parts = [
    ...commands.map((c) => `cmd:${c.trim()}`),
    ...toolCalls.map((t) => `tool:${t.name}`),
    ...fileRequests.map((f) => `file:${f.trim()}`),
  ];
  return parts.sort().join("|");
}
