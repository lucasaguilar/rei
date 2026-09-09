/**
 * Where the input line breaks, and where the cursor is inside it.
 *
 * The input used to wrap by pure division: row = cursor / width, col = cursor % width. That is exact
 * only while every row is exactly `width` wide — i.e. while the break is a hard cut at the right
 * edge, which is why a word like "descripcion" came out as "de" / "scricion".
 *
 * Breaking on words makes rows variable-width, so the division no longer holds and the row model has
 * to be explicit. Two invariants keep it honest:
 *
 *   1. Rows PARTITION the buffer. They are contiguous and cover it end to end, so every index
 *      belongs to exactly one row. A wrap that DISCARDED the space it broke on — the obvious
 *      implementation — would leave indices belonging to no row, and the cursor would sit one
 *      column off for the rest of the line. So the break character stays on the row it ends.
 *   2. One row model, three callers. The renderer draws the rows, and Up/Down move between them.
 *      They compute from this module or they disagree about where a line breaks.
 *
 * Indices are into the RAW buffer. A newline is one character here and is drawn as a one-column ↵
 * glyph, so raw length and visible width stay equal and the caller can slice rows directly.
 */

export interface InputRow {
  /** Index of the row's first character. */
  start: number;
  /** Index one past the row's last character. */
  end: number;
}

/** Characters a row is allowed to end on. */
const BREAK_CHARS = new Set([" ", "\t", "\n"]);

/** Split `text` into visual rows of at most `width` columns, breaking on words where it can. */
export function wrapInput(text: string, width: number): InputRow[] {
  if (width <= 0 || text.length <= width) return [{ start: 0, end: text.length }];

  const rows: InputRow[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (text.length - pos <= width) {
      rows.push({ start: pos, end: text.length });
      break;
    }
    // The longest row ≤ width that ends on a break character. The break is KEPT (invariant 1).
    let take = 0;
    for (let k = width; k >= 1; k--) {
      if (BREAK_CHARS.has(text[pos + k - 1])) {
        take = k;
        break;
      }
    }
    // A word longer than the row — a URL, a path — has no break to use: cut it at the edge.
    if (take === 0) take = width;
    rows.push({ start: pos, end: pos + take });
    pos += take;
  }
  return rows;
}

/** The cursor's 2D position. `cursor` may sit one past the last character, as it does at end of input. */
export function cursorRowCol(rows: InputRow[], cursor: number): { row: number; col: number } {
  for (let i = 0; i < rows.length; i++) {
    if (cursor < rows[i].end) return { row: i, col: cursor - rows[i].start };
  }
  const last = Math.max(0, rows.length - 1);
  return { row: last, col: Math.max(0, cursor - (rows[last]?.start ?? 0)) };
}

/**
 * The buffer index one visual row up (`delta` -1) or down (+1), keeping the column where it fits.
 *
 * Returns null when there is no row that way — the signal for the caller to fall back to history or
 * the command palette, which is what Up and Down otherwise do.
 */
export function moveCursorRow(
  text: string,
  width: number,
  cursor: number,
  delta: -1 | 1,
): number | null {
  const rows = wrapInput(text, width);
  const { row, col } = cursorRowCol(rows, cursor);
  const target = row + delta;
  if (target < 0 || target >= rows.length) return null;

  const t = rows[target];
  // Only the last row may hold the cursor one past its end; on any other row that index already
  // belongs to the row below.
  const maxIndex = target === rows.length - 1 ? t.end : t.end - 1;
  return Math.min(t.start + col, maxIndex);
}
