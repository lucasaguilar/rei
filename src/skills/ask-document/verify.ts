import type { ClaimStatus } from "./types.js";

// A quote shorter than this is too generic to verify meaningfully (e.g. "the network").
const MIN_QUOTE_CHARS = 12;
// Token-overlap above this counts as a (lightly reworded) match rather than a fabrication.
const FUZZY_THRESHOLD = 0.9;

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// Word tokens, punctuation-stripped — so "stories," matches "stories" in the fuzzy compare.
function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenOverlap(a: string, b: string): number {
  const at = new Set(words(a));
  if (at.size === 0) return 0;
  const bt = new Set(words(b));
  let hit = 0;
  for (const t of at) if (bt.has(t)) hit++;
  return hit / at.size;
}

/**
 * Deterministically verifies that a model's quote actually exists in the source document — the
 * text analog of MRZ check-digit validation: don't trust the model's claim, prove the quote is
 * really there.
 *  - "verified"   → the normalized quote is a verbatim substring of the source.
 *  - "fuzzy"      → not verbatim, but ≥90% of its tokens appear in a nearby window (light rewording).
 *  - "fabricated" → not found → the claim is unsupported and should be dropped/flagged.
 */
export function verifyQuote(quote: string, sourceText: string): ClaimStatus {
  const q = normalize(quote);
  if (q.length < MIN_QUOTE_CHARS) return "fabricated";

  const src = normalize(sourceText);
  if (src.includes(q)) return "verified";

  // Fuzzy: slide a window the size of the quote and take the best token overlap.
  const qLen = q.length;
  const step = Math.max(1, Math.floor(qLen / 2));
  let best = 0;
  for (let i = 0; i + qLen <= src.length; i += step) {
    best = Math.max(best, tokenOverlap(q, src.slice(i, i + qLen + step)));
    if (best >= FUZZY_THRESHOLD) return "fuzzy";
  }
  // Also try the whole source for short docs (cheap) in case the window stepping missed it.
  if (tokenOverlap(q, src) >= FUZZY_THRESHOLD) return "fuzzy";

  return "fabricated";
}
