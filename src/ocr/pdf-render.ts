import * as fs from "fs";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";

// Page budget + render scale for scanned-PDF OCR (each page is a separate vision call, so
// these guard against runaway cost/time on big documents). Override via env.
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_SCALE = 2; // 2× the PDF's native size — sharper small text for OCR.

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function floatEnv(name: string, fallback: number): number {
  const n = parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Rotate a rendered PNG data URL clockwise and return a fresh PNG data URL. Photos of books/
 * documents are often shot sideways or upside-down; a VL model can't read rotated text and spins
 * into hallucinated repetition loops (observed: a 90°-rotated page produced "PÁG. 18…PÁG. 481"
 * garbage; rotated upright it transcribed cleanly). The OCR flow (which owns orientation, via an
 * explicit REI_OCR_ROTATE or auto-detection) calls this per page before the vision request.
 * `degrees === 0` is a no-op (returns the input untouched — no decode/encode round-trip).
 */
export async function rotateDataUrl(dataUrl: string, degrees: number): Promise<string> {
  if (degrees === 0) return dataUrl;
  const input = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
  const out = await sharp(input).rotate(degrees).png().toBuffer();
  return `data:image/png;base64,${out.toString("base64")}`;
}

export interface RenderedPage {
  pageNumber: number;
  /** data:image/png;base64,… — feed directly to the vision model. */
  dataUrl: string;
}

export interface PdfRender {
  pages: RenderedPage[];
  /** Total pages in the document (may exceed pages.length when the budget truncated it). */
  total: number;
  /** True when the document had more pages than the budget and only the first N were rendered. */
  truncated: boolean;
}

/**
 * Rasterizes the first N pages of a PDF to PNG data URLs via pdf-parse v2's getScreenshot
 * (built on pdfjs — zero native deps). Used for SCANNED PDFs (no text layer): each rendered
 * page is then OCR'd by the vision model. The page budget (REI_OCR_PDF_MAX_PAGES) bounds the
 * number of vision calls.
 */
export async function renderPdfPages(
  pdfPath: string,
  opts?: { maxPages?: number; scale?: number },
): Promise<PdfRender> {
  const maxPages = opts?.maxPages ?? intEnv("REI_OCR_PDF_MAX_PAGES", DEFAULT_MAX_PAGES);
  const scale = opts?.scale ?? floatEnv("REI_OCR_PDF_SCALE", DEFAULT_SCALE);

  const buffer = await fs.promises.readFile(pdfPath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getScreenshot({
      imageDataUrl: true,
      scale,
      first: maxPages, // render only the first N pages (the budget)
    });
    const pages = result.pages
      .slice()
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((p) => ({ pageNumber: p.pageNumber, dataUrl: p.dataUrl }));
    const total = result.total ?? pages.length;
    return { pages, total, truncated: total > pages.length };
  } finally {
    await parser.destroy();
  }
}
