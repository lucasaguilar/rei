/**
 * Utilities for detecting infinite loops and degenerate model responses.
 *
 * Degenerate output: the model repeats a short phrase many times ("I will be. I am. I was.")
 * Command loops: the model generates the exact same tool/command calls as the previous iteration.
 */

/**
 * Returns true when the text looks like degenerate model output — a short phrase
 * repeating back-to-back many times. Strips XML and think blocks before checking.
 *
 * IMPORTANT: only CLUSTERED repetition counts (a real loop emits "X. X. X. X."
 * with the repeats adjacent). Distributed repetition — the same phrasing reused
 * across a long, legitimately parallel document (acceptance-criteria lists, spec
 * sections, tables) — is NOT degenerate. Counting total occurrences anywhere (the
 * old behavior) false-positived on those structured outputs and truncated valid
 * responses mid-spec.
 */
export function isDegenerate(text: string): boolean {
  // Strip XML tags and thinking blocks for a clean check
  const clean = text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length < 80) return false;

  // Only count WORD tokens (containing a letter). ASCII art / box-drawing logos, diagrams and
  // tables legitimately repeat SYMBOLS (█ ═ ╗ # = …), which is not a generation loop — a real
  // loop repeats actual words, which survive this filter. (Symbol-heavy art falls below the
  // word-count floor and is skipped.)
  const words = clean.split(" ").filter((w) => /\p{L}/u.test(w));
  if (words.length < 12) return false;

  // Sliding window: check 4- and 6-word n-grams. Record every position an n-gram
  // appears, then flag only when ≥4 of those occurrences are TIGHTLY CLUSTERED —
  // i.e. each repeat starts within a small gap of the previous one (a back-to-back
  // loop). Parallel structure repeats the same phrase but separated by lots of other
  // text, so the gaps are large and the run never reaches the threshold.
  for (const windowSize of [4, 6]) {
    const positions = new Map<string, number[]>();
    for (let i = 0; i <= words.length - windowSize; i++) {
      const gram = words
        .slice(i, i + windowSize)
        .join(" ")
        .toLowerCase();
      const arr = positions.get(gram);
      if (arr) arr.push(i);
      else positions.set(gram, [i]);
    }

    // A genuine loop has consecutive repeats within ~3 window-lengths of each other.
    const maxGap = windowSize * 3;
    for (const occ of positions.values()) {
      if (occ.length < 4) continue;
      let run = 1;
      for (let k = 1; k < occ.length; k++) {
        if (occ[k] - occ[k - 1] <= maxGap) {
          run++;
          if (run >= 4) return true;
        } else {
          run = 1;
        }
      }
    }
  }

  return false;
}
