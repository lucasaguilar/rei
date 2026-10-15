import { describe, expect, it } from "vitest";
import { wrapWords } from "./word-wrap.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const link = (label: string) => `\x1b]8;;file:///w/${label}\x1b\\${label}\x1b]8;;\x1b\\`;

describe("wrapWords — REI's answer breaks between words, not inside them", () => {
  it("breaks at the last space that fits, never in the middle of a word", () => {
    // The terminal cut "Changed" into "Change" / "d" at the right edge.
    const text = "Fixed. The loop skipped the first element. Changed the start index to 0.";
    const rows = wrapWords(text, 30).split("\n");
    expect(rows).toEqual(["Fixed. The loop skipped the", "first element. Changed the", "start index to 0."]);
  });

  it("does not count colour codes or link escapes as columns", () => {
    // 19 visible columns, exactly the row: with the escapes counted it would break, and wrongly.
    const text = `in ${link("src/sum.ts")} \x1b[36mi = 0\x1b[0m`;
    expect(plain(text)).toHaveLength(19);
    expect(wrapWords(text, 19)).toBe(text);
  });

  it("keeps a coloured span and a link whole when they move to the next row", () => {
    const text = `The bug was in ${link("src/sum.ts")}: the loop started at \x1b[36mi = 1\x1b[0m.`;
    const rows = wrapWords(text, 24).split("\n").map(plain);
    expect(rows).toEqual(["The bug was in", "src/sum.ts: the loop", "started at i = 1."]);
  });

  it("keeps existing line breaks and indents a list item's continuation", () => {
    const text = "Both tests pass:\n\n  * adds every number in the list\n  * returns 0";
    expect(wrapWords(text, 20).split("\n")).toEqual([
      "Both tests pass:",
      "",
      "  * adds every",
      "  number in the list",
      "  * returns 0",
    ]);
  });

  it("leaves a word longer than the row alone — the terminal is the only one who can cut it", () => {
    const text = "see /a/very/long/path/that/does/not/fit.ts now";
    expect(wrapWords(text, 20).split("\n")).toEqual(["see", "/a/very/long/path/that/does/not/fit.ts", "now"]);
  });
});
