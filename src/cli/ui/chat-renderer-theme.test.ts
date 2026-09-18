import { describe, it, expect, afterEach, vi } from "vitest";
import { ChatRenderer } from "./chat-renderer.js";
import { setTheme, THEMES, RESET } from "../theme/palette.js";
import type { ChatRendererState } from "../models/chat.types.js";

afterEach(() => setTheme(undefined));

function frame(): string {
  const out: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  ChatRenderer.resetDrawnState();
  ChatRenderer.draw({
    cols: 90,
    rows: 40,
    activePalette: { kind: "command", items: [] },
    selectedCommandIndex: 0,
    historySearchMode: false,
    historySearchQuery: "",
    inputHistory: [],
    busy: true,
    activeStatus: "calling_model",
    statusStartedAt: Date.now() - 12_000,
    thinkingTail: "reviso el compactador",
    spinnerIndex: 1,
    sessionMode: "agent",
    inputBuffer: "hola",
    inputCursor: 4,
    contextTokens: 24_000,
    contextWindow: 100_000,
    modelLabel: "omlx / Qwen3.8-27B-MLX-4bit",
  } as ChatRendererState);
  spy.mockRestore();
  return out.join("");
}

/**
 * The drawn block is the surface a theme owns, so this is where a theme is proven: the same frame,
 * repainted, with nothing left open at the end.
 */
describe("the chrome under each theme", () => {
  it("draws the default theme's colours when none is chosen", () => {
    setTheme("default");
    const out = frame();
    expect(out).toContain(THEMES.default.accent); // spinner
    expect(out).toContain(THEMES.default.promptAgent); // prompt
    expect(out).not.toContain(THEMES.matrix.badge);
  });

  it("repaints the same frame in matrix green", () => {
    setTheme("matrix");
    const out = frame();
    expect(out).toContain(THEMES.matrix.accent);
    expect(out).toContain(THEMES.matrix.promptAgent);
    expect(out).toContain(THEMES.matrix.thinking);
  });

  it("closes every colour it opens, in both themes", () => {
    // Counted rather than eyeballed: one unclosed escape in a block that is redrawn ten times a
    // second leaves the terminal painted, and it survives REI exiting.
    for (const theme of ["default", "matrix"] as const) {
      setTheme(theme);
      const out = frame();
      // Colour escapes only — cursor moves and line clears are not styling.
      const opened = (out.match(/\x1b\[[0-9;]*m/g) ?? []).filter((e) => e !== RESET).length;
      const closed = (out.match(/\x1b\[0m/g) ?? []).length;
      expect(closed, `${theme}: ${opened} opened, ${closed} closed`).toBe(opened);
    }
  });
});
