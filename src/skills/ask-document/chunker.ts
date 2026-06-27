import type { DocChunk } from "./types.js";

// Target chunk size in characters (~400 tokens). Chunks are split at paragraph/sentence
// boundaries within a page so retrieval returns coherent passages.
const DEFAULT_CHUNK_CHARS = 1600;
const OVERLAP_CHARS = 200;

function intEnv(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface PageRegion {
  page: number;
  text: string;
}

/**
 * Splits a document into page-tagged regions, handling both OCR marker formats:
 *  - pdf-parse digital:  text … `-- N of M --`   (marker AFTER the page's text)
 *  - scanned page OCR:   `--- Page N ---` … text  (marker BEFORE the page's text)
 * Falls back to a single page 0 when there are no markers.
 */
export function splitIntoPages(text: string): PageRegion[] {
  const trailing = /\n?\s*--\s*(\d+)\s+of\s+\d+\s*--\s*\n?/gi; // pdf-parse
  const leading = /\n?\s*---\s*Page\s+(\d+)\s*---\s*\n?/gi; // scanned OCR

  if (trailing.test(text)) {
    trailing.lastIndex = 0;
    const regions: PageRegion[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = trailing.exec(text)) !== null) {
      const body = text.slice(last, m.index).trim();
      if (body) regions.push({ page: parseInt(m[1], 10), text: body });
      last = trailing.lastIndex;
    }
    const tail = text.slice(last).trim();
    if (tail) regions.push({ page: (regions.at(-1)?.page ?? 0) + 1, text: tail });
    return regions.length ? regions : [{ page: 0, text: text.trim() }];
  }

  if (leading.test(text)) {
    leading.lastIndex = 0;
    const regions: PageRegion[] = [];
    let currentPage = 0;
    let last = 0;
    let m: RegExpExecArray | null;
    const flush = (end: number, page: number) => {
      const body = text.slice(last, end).trim();
      if (body && page > 0) regions.push({ page, text: body });
      last = end;
    };
    while ((m = leading.exec(text)) !== null) {
      flush(m.index, currentPage);
      currentPage = parseInt(m[1], 10);
      last = leading.lastIndex;
    }
    flush(text.length, currentPage);
    return regions.length ? regions : [{ page: 0, text: text.trim() }];
  }

  return [{ page: 0, text: text.trim() }];
}

/** Splits a page's text into ~chunkChars pieces at paragraph/sentence boundaries, with overlap. */
function splitRegion(text: string, chunkChars: number): string[] {
  if (text.length <= chunkChars) return [text];
  const chunks: string[] = [];
  // Prefer paragraph boundaries; fall back to a hard slice with overlap.
  const paras = text.split(/\n{2,}/);
  let buf = "";
  for (const para of paras) {
    if (buf && buf.length + para.length + 2 > chunkChars) {
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - OVERLAP_CHARS)); // carry overlap
    }
    buf += (buf ? "\n\n" : "") + para;
    // A single huge paragraph: hard-split it.
    while (buf.length > chunkChars * 1.5) {
      chunks.push(buf.slice(0, chunkChars).trim());
      buf = buf.slice(chunkChars - OVERLAP_CHARS);
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/**
 * Page-aware chunker. Returns chunks tagged with their page number, ready to embed.
 * Strips the OCR file header (`# Extracted text …` / `> N page(s) …`) if present.
 */
export function chunkDocument(raw: string): DocChunk[] {
  // Drop the generated header so it isn't indexed as content.
  const text = raw.replace(/^#\s*Extracted text[\s\S]*?\n---\n/, "").trim();
  const chunkChars = intEnv("REI_DOC_CHUNK_CHARS", DEFAULT_CHUNK_CHARS);

  const chunks: DocChunk[] = [];
  for (const region of splitIntoPages(text)) {
    const pieces = splitRegion(region.text, chunkChars);
    pieces.forEach((piece, i) => {
      if (piece.trim().length > 0) {
        chunks.push({ id: `p${region.page}#${i}`, page: region.page, text: piece });
      }
    });
  }
  return chunks;
}
