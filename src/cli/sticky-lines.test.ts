import { describe, it, expect } from "vitest";
import { formatContextBar } from "./markdown-renderer.js";
import { fitLine } from "./helpers/terminal.helpers.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Every line in the redrawn block must fit the terminal on ONE row.
 *
 * `lastDrawnLinesCount` counts logical lines and `clearUI` erases that many terminal ROWS, so a line
 * that wraps leaves one row behind on every redraw. With a long model label in a narrow terminal
 * that is exactly what happened: the context bar came to 65 columns in a 62-column window, and the
 * shortcut hint piled up the screen, one copy per keystroke.
 */
const LONG_LABEL = "llmstudio / qwen/qwen3.8-27b-reasoning-community";

describe("the sticky context bar fits its row", () => {
  it("overflows a narrow terminal before clipping — the case that broke", () => {
    const bar = plain(formatContextBar(8200, 100_352, LONG_LABEL) ?? "");
    expect(bar.length).toBeGreaterThan(62);
  });

  it("fits once clipped, at every width the renderer uses", () => {
    const bar = formatContextBar(8200, 100_352, LONG_LABEL) ?? "";
    for (const cols of [40, 62, 76, 100, 200]) {
      expect(plain(fitLine(bar, cols)).length).toBeLessThanOrEqual(cols);
    }
  });

  it("keeps the numbers visible when it has to cut — they lead the line", () => {
    // The label is the expendable half: the fill percentage is why the bar exists.
    const fitted = plain(fitLine(formatContextBar(8200, 100_352, LONG_LABEL) ?? "", 40));
    expect(fitted).toContain("8.2k/100k");
    expect(fitted).toContain("8%");
  });

  it("leaves a short bar untouched", () => {
    const bar = formatContextBar(1000, 100_000, "ollama/x") ?? "";
    expect(plain(fitLine(bar, 100))).toBe(plain(bar));
  });
});
