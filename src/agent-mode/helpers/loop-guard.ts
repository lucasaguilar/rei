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
  return degenerateSpan(text) !== null;
}

/** The clustered n-gram that trips `isDegenerate`, or null. Separate from the boolean so a caller
 *  can LOG what it found: a cut that cannot be inspected afterwards cannot be judged. */
function degenerateSpan(text: string): { gram: string; occurrences: number; words: number } | null {
  // Strip XML tags and thinking blocks for a clean check
  const clean = text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length < 80) return null;

  // Only count WORD tokens (containing a letter). ASCII art / box-drawing logos, diagrams and
  // tables legitimately repeat SYMBOLS (█ ═ ╗ # = …), which is not a generation loop — a real
  // loop repeats actual words, which survive this filter. (Symbol-heavy art falls below the
  // word-count floor and is skipped.)
  const words = clean.split(" ").filter((w) => /\p{L}/u.test(w));
  if (words.length < 12) return null;

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
          if (run >= 4) {
            const gram = words.slice(occ[k - run + 1], occ[k] + windowSize).join(" ");
            return { gram, occurrences: run, words: words.length };
          }
        } else {
          run = 1;
        }
      }
    }
  }

  return null;
}

/**
 * Returns true when a LONG generation keeps coming back to the same sentences.
 *
 * `isDegenerate` looks for repeats that are back-to-back ("X. X. X. X."), and deliberately so: it
 * must not fire on a spec whose sections legitimately echo each other. But a local reasoning model
 * has a second failure mode it cannot see — it cycles through whole PARAGRAPHS, re-deriving the
 * same three ideas with tens of words in between, for as long as you let it. Observed on a 27B:
 * 12,000 output tokens in one call, the same two paragraphs four times over, and the turn ending
 * wherever generation happened to stop.
 *
 * So distance is ignored here and the bar is raised elsewhere: a whole BLOCK — fifty words, word
 * for word — coming back three times inside an output long enough that no answer needs it.
 *
 * The block length is the part that matters, and it is what keeps the old false positive away. A
 * list with parallel structure repeats its phrasing but never a fifty-word span: something varies
 * every sentence or two — an index, a filename, a criterion — and that break is enough. A cycling
 * decoder reproduces the region verbatim, filler and all.
 */
const CYCLE_WINDOW = 50;
const CYCLE_OCCURRENCES = 3;
const CYCLE_MIN_WORDS = 400;

export function isCyclicRepetition(text: string): boolean {
  return cyclicSpan(text) !== null;
}

/** The repeated block that trips `isCyclicRepetition`, or null. */
function cyclicSpan(text: string): { gram: string; occurrences: number; words: number } | null {
  const words = text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => /\p{L}/u.test(w));
  if (words.length < CYCLE_MIN_WORDS) return null;

  const seen = new Map<string, number>();
  for (let i = 0; i <= words.length - CYCLE_WINDOW; i++) {
    const gram = words.slice(i, i + CYCLE_WINDOW).join(" ").toLowerCase();
    const count = (seen.get(gram) ?? 0) + 1;
    if (count >= CYCLE_OCCURRENCES) {
      return { gram, occurrences: count, words: words.length };
    }
    seen.set(gram, count);
  }
  return null;
}

/**
 * Whether the loop guard is allowed to cut a stream at all.
 *
 * It ships ON, and it ships with an OFF switch, because a detector that stops a turn is one that
 * can stop the WRONG turn — and a user who hits that has no way around it otherwise. The shape most
 * at risk is a long plan whose sections are deliberately parallel: repetition there is the format,
 * not a decoder stuck in a groove. `REI_LOOP_GUARD=off` turns it off for the session; the thinking
 * is still counted and the turn simply runs to its natural end.
 */
export function loopGuardEnabled(): boolean {
  const raw = process.env.REI_LOOP_GUARD?.trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

/** Longest excerpt worth putting on a log line: enough to recognise the span, short enough to read. */
const EXCERPT_MAX = 200;

/** What tripped the guard. `kind` distinguishes the two failure modes; `excerpt` is the repeated span
 *  itself, which is the part that lets a human say "that was a real loop" or "that was my table". */
export interface LoopDiagnosis {
  kind: "phrase" | "cycle";
  excerpt: string;
  occurrences: number;
  /** Words scanned — a cut after 8,000 words reads very differently from one after 200. */
  words: number;
}

/**
 * The same verdict `looksLooping` gives, with the evidence attached.
 *
 * The guard used to log only THAT it cut, so a false positive and a real loop were indistinguishable
 * afterwards and the only way to judge it was to switch it off and see. Recording the span costs one
 * log line and turns "it fires a lot lately" into something answerable.
 */
export function diagnoseLoop(text: string): LoopDiagnosis | null {
  if (!loopGuardEnabled()) return null;
  const phrase = degenerateSpan(text);
  if (phrase) {
    return {
      kind: "phrase",
      excerpt: phrase.gram.slice(0, EXCERPT_MAX),
      occurrences: phrase.occurrences,
      words: phrase.words,
    };
  }
  const cycle = cyclicSpan(text);
  if (cycle) {
    return {
      kind: "cycle",
      excerpt: cycle.gram.slice(0, EXCERPT_MAX),
      occurrences: cycle.occurrences,
      words: cycle.words,
    };
  }
  return null;
}

/** Either failure mode: the tight phrase loop, or the long paragraph cycle. Off → neither. */
export function looksLooping(text: string): boolean {
  return diagnoseLoop(text) !== null;
}
