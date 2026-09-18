import { describe, it, expect } from "vitest";
import { formatContextBar } from "./markdown-renderer.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string | null): string => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The full gauge is printed once per turn and scrolls away, so the number you want when deciding
 * whether to `/clear` is never the one on screen. This compact version lives in the redrawn block
 * above the prompt, where it stays — which is why it has to be short.
 */
describe("formatContextBar", () => {
  it("reads as tokens, window and percentage", () => {
    expect(plain(formatContextBar(15_501, 100_352, "lmstudio/ornith"))).toBe(
      "16k/100k · 15% · lmstudio/ornith",
    );
  });

  it("keeps one decimal below 10k, where rounding would hide the change", () => {
    // "1k" for anything from 1000 to 1999 makes the bar look frozen while it fills.
    expect(plain(formatContextBar(1200, 100_352))).toContain("1.2k");
    expect(plain(formatContextBar(9900, 100_352))).toContain("9.9k");
    expect(plain(formatContextBar(15_501, 100_352))).toContain("16k");
  });

  it("shows small counts exactly rather than as 0k", () => {
    expect(plain(formatContextBar(320, 100_352))).toContain("320/");
  });

  it("draws nothing when no window is configured", () => {
    // A fill bar with no denominator says nothing, and the row is better spent on the prompt.
    expect(formatContextBar(5000, 0)).toBeNull();
  });

  it("escalates colour as the window fills, staying dim while it does not matter", () => {
    expect(formatContextBar(10_000, 100_000)).toContain("\x1b[2m"); // dim
    expect(formatContextBar(62_000, 100_000)).toContain("\x1b[33m"); // yellow
    expect(formatContextBar(88_000, 100_000)).toContain("\x1b[31m"); // red
  });

  it("caps at 100% instead of reporting an impossible fill", () => {
    expect(plain(formatContextBar(200_000, 100_000))).toContain("100%");
  });

  it("omits the model when there is none, without leaving a dangling separator", () => {
    expect(plain(formatContextBar(1000, 100_000)).trim().endsWith("1%")).toBe(true);
  });

  it("stays short enough to share the line with a narrow terminal", () => {
    expect(plain(formatContextBar(15_501, 100_352, "lmstudio/ornith-1.5-35b")).length)
      .toBeLessThanOrEqual(48);
  });
});
