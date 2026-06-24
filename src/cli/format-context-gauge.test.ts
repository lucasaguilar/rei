import { describe, it, expect } from "vitest";
import { formatContextGauge } from "./markdown-renderer.js";
import { estimateToolsTokens } from "../context/context-budget.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatContextGauge", () => {
  it("returns null for a non-positive window", () => {
    expect(formatContextGauge(100, 0)).toBeNull();
    expect(formatContextGauge(100, -1)).toBeNull();
  });

  it("renders the token counts and percentage", () => {
    const out = stripAnsi(formatContextGauge(2189, 122880)!);
    // toLocaleString is locale-dependent (e.g. "2,189" vs "2.189"), so build the
    // expected text the same way instead of hard-coding a separator.
    expect(out).toContain(
      `${(2189).toLocaleString()} / ${(122880).toLocaleString()} tokens`,
    );
    expect(out).toContain("2% used");
  });

  it("colors green / yellow / red by fill level", () => {
    expect(formatContextGauge(10000, 122880)!).toContain("\x1b[32m"); // ~8% green
    expect(formatContextGauge(90000, 122880)!).toContain("\x1b[33m"); // ~73% yellow
    expect(formatContextGauge(115000, 122880)!).toContain("\x1b[31m"); // ~94% red
  });

  it("reflects the MCP tools tokens once they're added to the history count", () => {
    const window = 122880;
    const historyTokens = 2189;
    // Before the fix the gauge only saw history (~2%).
    expect(stripAnsi(formatContextGauge(historyTokens, window)!)).toContain(
      "2% used",
    );
    // After including the tools array (~54890), it honestly shows ~46%.
    const toolsTokens = 54890;
    const combined = stripAnsi(
      formatContextGauge(historyTokens + toolsTokens, window)!,
    );
    expect(combined).toContain("46% used");
    expect(combined).toContain(
      `${(57079).toLocaleString()} / ${(122880).toLocaleString()} tokens`,
    );
  });
});

describe("estimateToolsTokens", () => {
  it("is 0 for an empty tools array", () => {
    expect(estimateToolsTokens([])).toBe(0);
  });

  it("grows as more tool schemas are added", () => {
    const tool = {
      type: "function",
      function: {
        name: "spotify_playMusic",
        description: "Play a track or playlist on a device",
        parameters: { type: "object", properties: { uri: { type: "string" } } },
      },
    };
    const few = estimateToolsTokens([tool]);
    const many = estimateToolsTokens(Array.from({ length: 20 }, () => tool));
    expect(few).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(few);
  });
});
