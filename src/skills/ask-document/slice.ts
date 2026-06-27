import { splitIntoPages } from "./chunker.js";

export interface PageSpec {
  /** First page of the range (1-based, inclusive). */
  from?: number;
  /** Last page of the range (inclusive). Omit = single page `from`. */
  to?: number;
  /** "first N pages" shorthand (ignored when from/to given). */
  first?: number;
}

export interface DocSlice {
  pages: number[];
  text: string;
}

// Ordinal words (en + es) → page number, so "second page" / "segunda página" work.
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5,
  sexta: 6, "séptima": 7, septima: 7, octava: 8, novena: 9, "décima": 10, decima: 10,
};

/**
 * Parses a page-range spec from free text: "pp.20-40", "p.5", "20-40", "first 3",
 * "page 5" / "página 5", "second page" / "segunda página". Undefined when none matches.
 */
export function parsePageSpec(text: string): PageSpec | undefined {
  const t = text.trim().toLowerCase();
  // "first 3" / "primeras 3" → first N pages (needs a digit; "first page" is handled below).
  const firstN = t.match(/^(?:first|primeras?)\s+(\d+)/);
  if (firstN) return { first: parseInt(firstN[1], 10) };
  // ordinal word + page → that single page: "second page", "segunda página".
  const ord = t.match(/^([a-zà-ÿ]+)\s+(?:page|página|pagina)\b/);
  if (ord && ORDINALS[ord[1]] !== undefined) return { from: ORDINALS[ord[1]] };
  // "page N" / "página N".
  const pageN = t.match(/(?:page|página|pagina)\s+(\d+)/);
  if (pageN) return { from: parseInt(pageN[1], 10) };
  const range = t.match(/^p{1,2}\.?\s*(\d+)\s*(?:-|a|to)\s*(\d+)/);
  if (range) return { from: parseInt(range[1], 10), to: parseInt(range[2], 10) };
  const single = t.match(/^p{1,2}\.?\s*(\d+)\b/);
  if (single) return { from: parseInt(single[1], 10) };
  const bare = t.match(/^(\d+)\s*-\s*(\d+)/);
  if (bare) return { from: parseInt(bare[1], 10), to: parseInt(bare[2], 10) };
  return undefined;
}

/**
 * Returns the literal text of the requested pages of a document (using its OCR page markers),
 * with `--- Page N ---` headers. This is for reading a SPECIFIC slice of a large doc (e.g. the
 * opening, or pages 20-40) without dumping the whole file into the context window. Defaults to
 * the first page when no spec is given.
 */
export function sliceDocument(rawText: string, spec?: PageSpec): DocSlice {
  // Drop the generated OCR header so it isn't returned as page content.
  const text = rawText.replace(/^#\s*Extracted text[\s\S]*?\n---\n/, "").trim();
  const regions = splitIntoPages(text);

  let selected = regions;
  if (spec?.first && spec.first > 0) {
    selected = regions.slice(0, spec.first);
  } else if (spec?.from) {
    const to = spec.to ?? spec.from;
    selected = regions.filter((r) => r.page >= spec.from! && r.page <= to);
  } else {
    selected = regions.slice(0, 1); // default: first page
  }

  if (selected.length === 0) {
    return { pages: [], text: "" };
  }

  const text2 = selected
    .map((r) => (r.page > 0 ? `--- Page ${r.page} ---\n${r.text}` : r.text))
    .join("\n\n");
  return { pages: selected.map((r) => r.page), text: text2 };
}
