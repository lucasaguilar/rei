import * as fs from "fs";
import { PDFParse } from "pdf-parse";

/** Heuristic: below this many extractable chars, the PDF is treated as having no text layer
 *  (likely scanned) — Phase 1 can't OCR it, so the caller falls back to a clear message. */
const MIN_TEXT_LAYER_CHARS = 16;

export interface PdfExtraction {
  /** Trimmed text extracted from the PDF's text layer. */
  text: string;
  /** Page count reported by the parser (0 if unknown). */
  pages: number;
  /** False when there is effectively no extractable text (scanned PDF → needs OCR render, Phase 2). */
  hasTextLayer: boolean;
}

/**
 * Extracts the text layer from a DIGITAL pdf via pdf-parse (zero-install, no native deps).
 * Scanned/image-only PDFs return `hasTextLayer: false` with empty text — Phase 1 does not
 * render+OCR pages (that's Phase 2); the caller surfaces a clear message instead.
 */
export async function extractPdfText(pdfPath: string): Promise<PdfExtraction> {
  const buffer = await fs.promises.readFile(pdfPath);
  // Copy into a fresh Uint8Array — pdfjs may detach the underlying buffer.
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    // Collapse runs of 3+ blank lines (pdf-parse is whitespace-noisy) but preserve words/lines.
    const text = (result.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return {
      text,
      pages: result.total ?? 0,
      hasTextLayer: text.length >= MIN_TEXT_LAYER_CHARS,
    };
  } finally {
    await parser.destroy();
  }
}
