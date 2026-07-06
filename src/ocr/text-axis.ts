import sharp from "sharp";

/**
 * Detects whether a page's TEXT LINES run horizontally or vertically, from pixels alone (no model).
 * Text forms a periodic pattern of ink bands (lines) and gaps PERPENDICULAR to the reading
 * direction. Projecting the ink onto each axis and measuring the projection's HIGH-FREQUENCY energy
 * (how sharply it oscillates) reveals which axis carries that line/gap ripple: upright text ripples
 * DOWN the rows → strong row-profile energy → "horizontal"; a 90°-rotated page ripples across the
 * columns → "vertical". This tells the AXIS only (horizontal ⇒ orientation 0°/180°, vertical ⇒
 * 90°/270°) — up-vs-down needs an OCR probe — but it cheaply halves the candidates and rules out the
 * wrong-axis orientations where a VL model hallucinates fluent-but-false text (the earlier failure).
 *
 * Robustness: photos of documents sit on a DARK surface and use multi-column layouts, which wreck a
 * naive dark-pixel projection. So we normalize contrast, TRIM the background border, and use the
 * high-frequency (line-ripple) energy rather than raw variance — the line pattern is high-frequency
 * while the background blob and column structure are low-frequency. Validated on real book photos.
 */
export type TextAxis = "horizontal" | "vertical";

const INK_THRESHOLD = 110; // greyscale < this = ink, after contrast normalization
const PROFILE_WIDTH = 800; // downscale target (speed + denoise)

/** Mean squared first-difference of a projection, normalized by its max — the line-ripple energy. */
function highFreqEnergy(counts: Float64Array, norm: number): number {
  if (counts.length < 2 || norm === 0) return 0;
  let sum = 0;
  for (let i = 1; i < counts.length; i += 1) {
    const d = (counts[i] - counts[i - 1]) / norm;
    sum += d * d;
  }
  return sum / counts.length;
}

export async function detectTextAxis(dataUrl: string): Promise<TextAxis> {
  const input = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
  let pipeline = sharp(input).greyscale().normalize();
  // Trim the (dark) background border so it can't dominate the projection. Trim can throw on a
  // uniform image — fall back to the untrimmed page in that case.
  try {
    pipeline = pipeline.trim({ threshold: 30 });
  } catch {
    pipeline = sharp(input).greyscale().normalize();
  }

  const { data, info } = await pipeline
    .resize({ width: PROFILE_WIDTH, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const rowInk = new Float64Array(height);
  const colInk = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[base + x] < INK_THRESHOLD) {
        rowInk[y] += 1;
        colInk[x] += 1;
      }
    }
  }

  const rowEnergy = highFreqEnergy(rowInk, width); // ripple DOWN rows ⇒ horizontal text
  const colEnergy = highFreqEnergy(colInk, height); // ripple ACROSS cols ⇒ vertical text
  return rowEnergy >= colEnergy ? "horizontal" : "vertical";
}
