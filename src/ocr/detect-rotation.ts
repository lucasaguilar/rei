import { rotateDataUrl } from "./pdf-render.js";
import { scoreOcrText } from "./rotation-score.js";

/**
 * Auto-detects a scanned page's upright orientation. Photos of documents come in at 0/90/180/270°,
 * and a VL model can only read the upright one — the rest produce garbage/loops. We rotate page 1
 * to each candidate, run a SHORT OCR probe, score each transcription for prose-coherence
 * ([[rotation-score]]), and return the winning rotation. All pages of a scan share an orientation,
 * so the caller applies this once and reuses it for the whole document.
 *
 * `probe` is injected (rather than importing the vision sidecar) to keep this module free of a
 * dependency cycle — the caller passes a closure over describeImageDataUrl with a small token cap.
 */

export type Rotation = 0 | 90 | 180 | 270;
const CANDIDATES: Rotation[] = [0, 90, 180, 270];

// Below this best-score, no orientation looks like real prose (a genuinely unreadable/blank scan) —
// don't rotate garbage into different garbage; leave it upright and let OCR report the failure.
const MIN_CONFIDENT_SCORE = 0.05;

export interface RotationDetection {
  rotation: Rotation;
  scores: Record<Rotation, number>;
}

export async function detectRotation(
  page1DataUrl: string,
  probe: (dataUrl: string) => Promise<string>,
  onStatus?: (message: string) => void,
): Promise<RotationDetection> {
  const scores = { 0: 0, 90: 0, 180: 0, 270: 0 } as Record<Rotation, number>;

  for (const deg of CANDIDATES) {
    try {
      const url = await rotateDataUrl(page1DataUrl, deg);
      const text = await probe(url);
      scores[deg] = scoreOcrText(text);
    } catch {
      scores[deg] = 0; // a failed/aborted probe just can't win
    }
    onStatus?.(`   ${deg}° → score ${scores[deg].toFixed(2)}`);
  }

  let best: Rotation = 0;
  for (const deg of CANDIDATES) if (scores[deg] > scores[best]) best = deg;
  // Prefer 0° on a tie or when nothing reads as prose (avoid rotating a bad scan needlessly).
  if (scores[best] < MIN_CONFIDENT_SCORE) best = 0;

  return { rotation: best, scores };
}
