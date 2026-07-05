/**
 * Heuristic "is this OCR output coherent prose?" score, used to pick a page's correct rotation
 * without a dictionary or an orientation model. When a VL model is fed sideways/upside-down text
 * it can't read it and emits garbage — most often a repetition/counting loop ("PÁG. 18…PÁG. 481")
 * or low-signal noise. Real transcribed prose, in contrast, is full of short function words
 * (de/la/que/the/of…), rarely repeats one token, and isn't mostly digits. We turn those three
 * signals into a single score; the rotation whose probe scores highest is the upright one.
 *
 * Deliberately language-light (es + en stopwords) and cheap — it runs on a ~200-token probe.
 */

// High-frequency function words in Spanish + English. Coherent prose is dense with these; a
// counting loop or rotated-garbage transcription is not.
const STOPWORDS = new Set([
  // Spanish
  "de", "la", "que", "el", "en", "y", "a", "los", "del", "se", "las", "por", "un", "para",
  "con", "no", "una", "su", "al", "lo", "como", "más", "pero", "sus", "le", "ya", "o", "este",
  "sí", "porque", "esta", "entre", "cuando", "muy", "sin", "sobre", "también", "me", "hasta",
  "es", "son", "si", "tu", "te", "tus",
  // English
  "the", "of", "and", "to", "in", "is", "that", "for", "it", "as", "with", "was", "on", "are",
  "be", "by", "this", "or", "an", "not", "from", "at", "but", "have", "has", "you", "your",
]);

/**
 * Returns a coherence score (higher = more like real prose). Text too short to judge scores 0.
 * The score can go negative for loops/garbage. Only relative ordering across rotations matters.
 */
export function scoreOcrText(text: string): number {
  const words = (text.toLowerCase().match(/[a-záéíóúñü]{2,}/g) ?? []);
  if (words.length < 8) return 0; // not enough signal to judge orientation

  const total = words.length;
  const freq = new Map<string, number>();
  let stop = 0;
  for (const w of words) {
    if (STOPWORDS.has(w)) stop += 1;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  const stopRatio = stop / total; // ↑ coherent prose
  const maxFreq = Math.max(...freq.values()) / total; // ↑ a single token dominates (loop)
  const numTokens = (text.match(/\d+/g) ?? []).length;
  const numRatio = numTokens / (total + numTokens); // ↑ counting-loop / form-noise

  // Reward function-word density; punish token repetition and digit soup.
  return stopRatio - maxFreq * 0.5 - numRatio * 0.5;
}
