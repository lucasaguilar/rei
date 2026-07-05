/**
 * Deterministic cleanup for VL OCR repetition loops. Local vision models, on a hard page, fall
 * into a degenerate loop and emit the same clause/line dozens of times — observed:
 * "…sufras el daño de fuego, sufras el daño de fuego, sufras el daño de fuego, …". A sampling
 * penalty only lowers the ODDS of that; this collapses it after the fact so the saved transcription
 * is clean no matter how the model behaved. Only runs of 3+ IDENTICAL consecutive units collapse,
 * which real prose effectively never has — so legitimate text is left untouched.
 */

// Require this many consecutive copies before collapsing (2 is common in real text: "no, no").
const MIN_RUN = 3;

/**
 * Collapse a clause repeated 3+ times in a row ("X, X, X, X." → "X,"). Splits on comma/semicolon
 * and compares each clause's CORE (trimmed, trailing punctuation/space stripped, lowercased) so a
 * run ending in a different delimiter (e.g. the last copy ends in "." not ",") still collapses to
 * a single clause. The kept clause preserves its original delimiter/spacing.
 */
function collapseInlineClauses(text: string): string {
  const segs = text.match(/[^,;]*[,;]|[^,;]+$/g);
  if (!segs) return text;
  const core = (s: string): string => s.replace(/[\s,;.]+$/, "").trim().toLowerCase();

  const out: string[] = [];
  let i = 0;
  while (i < segs.length) {
    const c = core(segs[i]);
    let j = i;
    while (j + 1 < segs.length && core(segs[j + 1]) === c) j += 1;
    const run = j - i + 1;
    if (c !== "" && run >= MIN_RUN) out.push(segs[i]); // whole run → first clause only
    else for (let k = i; k <= j; k += 1) out.push(segs[k]);
    i = j + 1;
  }
  return out.join("");
}

/** Collapse 3+ identical consecutive (non-blank) lines down to one. */
function collapseRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const key = lines[i].trim();
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].trim() === key) j += 1;
    const run = j - i + 1;
    if (key !== "" && run >= MIN_RUN) out.push(lines[i]); // whole run → one line
    else for (let k = i; k <= j; k += 1) out.push(lines[k]);
    i = j + 1;
  }
  return out.join("\n");
}

/** Remove degenerate repetition loops from an OCR transcription (idempotent, prose-safe). */
export function collapseRepetition(text: string): string {
  return collapseRepeatedLines(collapseInlineClauses(text));
}

/**
 * How many characters the collapse removed — a proxy for "did the model loop?". A large number
 * means a repetition loop was cleaned (and likely ate the page's remaining real content), so the
 * caller may want to re-OCR the page once.
 */
export function repetitionRemoved(text: string): number {
  return text.length - collapseRepetition(text).length;
}
