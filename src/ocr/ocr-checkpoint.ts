import * as fs from "fs";
import * as path from "path";

/**
 * Resume checkpoint for scanned-PDF OCR. Each page's transcription is flushed to disk the moment
 * it completes, so an interrupted, crashed, or flaky run (dropped connections, timeouts) RESUMES
 * instead of re-OCR'ing everything. Rendering pages is cheap; the vision call per page is the slow,
 * failure-prone part — so we checkpoint the OCR text, not the render.
 *
 * The checkpoint lives hidden in `<workspace>/.rei/ocr/<base>.pages.md` (internal plumbing). The
 * user-facing `<workspace>/ocr/<base>.ocr.md` (see ocr-output.ts) remains the injectable artifact.
 * Pages are appended in completion order; callers reassemble by page number. Deleting the
 * checkpoint file forces a fresh OCR on the next run.
 */

const pageMarker = (n: number): string => `--- Page ${n} ---`;
const PAGE_MARKER_RE = /^--- Page (\d+) ---$/gm;

/** Absolute path to the resume checkpoint for a given source PDF. */
export function checkpointPath(sourcePath: string, workspacePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(workspacePath, ".rei", "ocr", `${base}.pages.md`);
}

/**
 * Parse an existing checkpoint into a `pageNumber → text` map. Only pages with real content are
 * returned (a marker with no text below it is treated as not-yet-done, so it gets retried).
 * Missing/unreadable file → empty map.
 */
export async function readCheckpoint(file: string): Promise<Map<number, string>> {
  const done = new Map<number, string>();
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf-8");
  } catch {
    return done;
  }
  const matches = [...raw.matchAll(PAGE_MARKER_RE)];
  for (let i = 0; i < matches.length; i += 1) {
    const pageNum = Number(matches[i][1]);
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    const text = raw.slice(start, end).trim();
    if (text) done.set(pageNum, text);
  }
  return done;
}

/** Append one page's transcription to the checkpoint, creating the dir/file if needed. */
export async function appendCheckpointPage(
  file: string,
  pageNumber: number,
  text: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, `${pageMarker(pageNumber)}\n${text}\n\n`, "utf-8");
}
