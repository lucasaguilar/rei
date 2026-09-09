import { describe, it, expect } from "vitest";
import { wrapInput, cursorRowCol, moveCursorRow, InputRow } from "./input-wrap.js";
import { MODE_PROMPTS, continuationPrompt } from "../constants/chat.constants.js";
import { visibleLength, inputWrapWidth } from "../helpers/terminal.helpers.js";

const rowText = (text: string, rows: InputRow[]): string[] =>
  rows.map((r) => text.slice(r.start, r.end));

describe("wrapInput", () => {
  it("breaks on a word boundary instead of mid-word", () => {
    // The reported bug: at width 10, "descripcion" came out as "de" / "scricion".
    const text = "dame una descripcion";
    expect(rowText(text, wrapInput(text, 10))).toEqual(["dame una ", "descripcio", "n"]);
  });

  it("keeps every row within the width", () => {
    const text = "the quick brown fox jumps over the lazy dog again and again and again";
    for (const width of [8, 12, 20, 33]) {
      for (const row of wrapInput(text, width)) {
        expect(row.end - row.start).toBeLessThanOrEqual(width);
      }
    }
  });

  it("cuts a word longer than the row rather than looping forever", () => {
    const text = "see https://example.com/a/very/long/path/indeed now";
    const rows = wrapInput(text, 10);
    expect(rows.every((r) => r.end > r.start)).toBe(true);
    expect(rowText(text, rows).join("")).toBe(text);
  });

  it("returns one row for text that fits", () => {
    expect(wrapInput("short", 20)).toEqual([{ start: 0, end: 5 }]);
  });

  it("returns one empty row for an empty buffer", () => {
    expect(wrapInput("", 20)).toEqual([{ start: 0, end: 0 }]);
  });

  it("survives a width of zero, which a very narrow terminal produces", () => {
    expect(wrapInput("abc", 0)).toEqual([{ start: 0, end: 3 }]);
  });

  it("breaks after a newline, which is one column wide as a ↵ glyph", () => {
    const text = "one\ntwo three four";
    expect(rowText(text, wrapInput(text, 6))).toEqual(["one\n", "two ", "three ", "four"]);
  });
});

/**
 * Invariant 1: rows partition the buffer. This is the one that keeps the cursor column honest —
 * a wrap that dropped the space it broke on passes every "looks right" test above and still puts
 * the cursor one column off for the rest of the line.
 */
describe("rows partition the buffer", () => {
  const samples = [
    "dame una descripcion de cada archivo y grupo",
    "a  b   c    d",
    "nospacesatallinthisonesoitmustbecutbywidth",
    "trailing space ",
    " leading space",
    "one\ntwo\nthree",
  ];

  it("covers every index exactly once, at every width", () => {
    for (const text of samples) {
      for (let width = 1; width <= 20; width++) {
        const rows = wrapInput(text, width);
        expect(rows[0].start).toBe(0);
        expect(rows[rows.length - 1].end).toBe(text.length);
        for (let i = 1; i < rows.length; i++) expect(rows[i].start).toBe(rows[i - 1].end);
        expect(rowText(text, rows).join("")).toBe(text);
      }
    }
  });
});

describe("cursorRowCol", () => {
  const text = "dame una descripcion";
  const rows = wrapInput(text, 10); // ["dame una ", "descripcio", "n"]

  it("puts the cursor at the start of the buffer", () => {
    expect(cursorRowCol(rows, 0)).toEqual({ row: 0, col: 0 });
  });

  it("maps a row boundary to column 0 of the row below, not past the row above", () => {
    expect(cursorRowCol(rows, 9)).toEqual({ row: 1, col: 0 });
  });

  it("keeps the break character on the row it ends", () => {
    expect(cursorRowCol(rows, 8)).toEqual({ row: 0, col: 8 }); // the space
  });

  it("allows the cursor one past the last character", () => {
    expect(cursorRowCol(rows, text.length)).toEqual({ row: 2, col: 1 });
  });

  it("reports row 0 for an empty buffer", () => {
    expect(cursorRowCol(wrapInput("", 10), 0)).toEqual({ row: 0, col: 0 });
  });

  it("agrees with the wrap for every index in the buffer", () => {
    // The renderer draws rows[i] and places the cursor at col: if these disagree the cursor lands
    // on a character other than the one it is logically on.
    for (let i = 0; i <= text.length; i++) {
      const { row, col } = cursorRowCol(rows, i);
      expect(rows[row].start + col).toBe(i);
    }
  });
});

describe("moveCursorRow", () => {
  const text = "dame una descripcion"; // rows at 10: "dame una " | "descripcio" | "n"

  it("moves down a row keeping the column", () => {
    expect(moveCursorRow(text, 10, 2, 1)).toBe(11); // row 0 col 2 → row 1 col 2
  });

  it("moves back up to the same column", () => {
    expect(moveCursorRow(text, 10, 11, -1)).toBe(2);
  });

  it("clamps to the end of a shorter row instead of overshooting into the next", () => {
    expect(moveCursorRow(text, 10, 15, 1)).toBe(text.length); // row 2 holds only "n"
  });

  it("returns null above the first row, so Up falls through to history", () => {
    expect(moveCursorRow(text, 10, 3, -1)).toBeNull();
  });

  it("returns null below the last row, so Down falls through to the palette", () => {
    expect(moveCursorRow(text, 10, text.length, 1)).toBeNull();
  });

  it("returns null on a single-row buffer in both directions", () => {
    expect(moveCursorRow("short", 40, 2, -1)).toBeNull();
    expect(moveCursorRow("short", 40, 2, 1)).toBeNull();
  });

  it("never lands on an index belonging to another row", () => {
    for (let i = 0; i <= text.length; i++) {
      for (const delta of [-1, 1] as const) {
        const next = moveCursorRow(text, 10, i, delta);
        if (next === null) continue;
        const rows = wrapInput(text, 10);
        const from = cursorRowCol(rows, i).row;
        expect(cursorRowCol(rows, next).row).toBe(from + delta);
      }
    }
  });
});

/**
 * The renderer indents every wrapped row by the prompt's width, and `inputWrapWidth` subtracts that
 * same width to get the wrap width. Both read it from MODE_PROMPTS, so a prompt of a different
 * length is not a cosmetic difference: it moves the whole input block sideways on /mode, and gives
 * each mode a different number of usable columns.
 */
describe("the mode prompts share one width", () => {
  it("is the same for every mode", () => {
    const widths = Object.values(MODE_PROMPTS).map((p) => visibleLength(p));
    expect(new Set(widths).size).toBe(1);
  });

  it("gives every mode the same room to type in", () => {
    const widths = Object.keys(MODE_PROMPTS).map((m) => inputWrapWidth(m, 100));
    expect(new Set(widths).size).toBe(1);
  });

  it("still names the mode, which is what the indent buys", () => {
    expect(MODE_PROMPTS.agent).toContain("agent");
    expect(MODE_PROMPTS.planning).toContain("plan");
    expect(MODE_PROMPTS.ask).toContain("ask");
  });
});

/**
 * The continuation gutter replaces the prompt on wrapped rows. Its width is not decoration: the
 * renderer draws `gutter + rowText` and then puts the terminal cursor at `promptLen + col`, so a
 * gutter that is a column off puts the text and the cursor in different places — and the text is
 * what you see while the cursor is where you type.
 */
describe("the continuation marker", () => {
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

  it("is exactly as wide as the prompt it continues, for every mode", () => {
    for (const prompt of Object.values(MODE_PROMPTS)) {
      const width = visibleLength(prompt);
      expect(visibleLength(continuationPrompt(width))).toBe(width);
    }
  });

  it("puts the ⋮ in the same column as the prompt's »", () => {
    for (const prompt of Object.values(MODE_PROMPTS)) {
      expect(strip(continuationPrompt(visibleLength(prompt))).indexOf("⋮")).toBe(
        strip(prompt).indexOf("»"),
      );
    }
  });

  it("is dim, so it reads as a rail and not as typed input", () => {
    expect(continuationPrompt(11)).toContain("\x1b[90m");
  });

  it("keeps its width at degenerate widths rather than throwing", () => {
    for (const width of [0, 1, 2, 3]) {
      expect(visibleLength(continuationPrompt(width))).toBe(width);
    }
  });
});
