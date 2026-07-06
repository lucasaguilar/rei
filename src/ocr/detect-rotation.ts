import { rotateDataUrl } from "./pdf-render.js";
import { scoreOcrText } from "./rotation-score.js";
import { detectTextAxis, type TextAxis } from "./text-axis.js";

/**
 * Auto-detects a scanned page's upright orientation. Photos of documents come in at 0/90/180/270°,
 * and a VL model can only read the upright one — the rest produce garbage/loops. Two stages:
 *   1. A cheap pixel-only pass ([[text-axis]]) decides whether text lines are horizontal (⇒ 0/180)
 *      or vertical (⇒ 90/270), halving the candidates and — crucially — excluding the WRONG-axis
 *      orientations, where a VL model hallucinates fluent-but-false text that fooled a pure OCR
 *      score (the earlier 4-way approach picked 180° on a 90° page for exactly this reason).
 *   2. A short OCR probe on each surviving candidate, scored for prose coherence, picks upright vs
 *      upside-down. If neither reads as prose (axis likely misjudged), it falls back to probing the
 *      other axis too before giving up on 0°.
 * All pages of a scan share orientation, so the caller runs this once and reuses it.
 *
 * `probe` is injected (not importing the vision sidecar) to avoid a dependency cycle; `axisDetector`
 * is injectable for testing.
 */

export type Rotation = 0 | 90 | 180 | 270;

// Below this best-score nothing reads as prose (blank/unreadable scan) — don't rotate garbage into
// different garbage; stay at 0° and let OCR report the failure.
const MIN_CONFIDENT_SCORE = 0.05;

const AXIS_CANDIDATES: Record<TextAxis, [Rotation, Rotation]> = {
  horizontal: [0, 180],
  vertical: [90, 270],
};

export interface RotationDetection {
  rotation: Rotation;
  scores: Partial<Record<Rotation, number>>;
  axis: TextAxis;
}

export async function detectRotation(
  page1DataUrl: string,
  probe: (dataUrl: string) => Promise<string>,
  onStatus?: (message: string) => void,
  axisDetector: (dataUrl: string) => Promise<TextAxis> = detectTextAxis,
): Promise<RotationDetection> {
  const axis = await axisDetector(page1DataUrl);
  onStatus?.(`   líneas de texto ${axis === "horizontal" ? "horizontales" : "verticales"} → probando ${AXIS_CANDIDATES[axis].join("°/")}°`);

  const scores: Partial<Record<Rotation, number>> = {};
  const probeCandidate = async (deg: Rotation): Promise<void> => {
    try {
      scores[deg] = scoreOcrText(await probe(await rotateDataUrl(page1DataUrl, deg)));
    } catch {
      scores[deg] = 0; // a failed/aborted probe can't win
    }
    onStatus?.(`   ${deg}° → score ${(scores[deg] ?? 0).toFixed(2)}`);
  };

  const pickBest = (): Rotation => {
    let best: Rotation = 0;
    for (const deg of [0, 90, 180, 270] as Rotation[]) {
      if (scores[deg] !== undefined && scores[deg]! > (scores[best] ?? -Infinity)) best = deg;
    }
    return best;
  };

  // Stage 2: probe the primary axis; if nothing there reads as prose, the axis was likely misjudged
  // (noisy scan) — probe the other axis before defaulting to 0°.
  for (const deg of AXIS_CANDIDATES[axis]) await probeCandidate(deg);
  let best = pickBest();
  if ((scores[best] ?? 0) < MIN_CONFIDENT_SCORE) {
    const other: TextAxis = axis === "horizontal" ? "vertical" : "horizontal";
    for (const deg of AXIS_CANDIDATES[other]) await probeCandidate(deg);
    best = pickBest();
  }

  if ((scores[best] ?? 0) < MIN_CONFIDENT_SCORE) best = 0; // nothing legible → don't rotate
  return { rotation: best, scores, axis };
}
