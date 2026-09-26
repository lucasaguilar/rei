import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS script shipped standalone to ~/.rei/scripts, no .d.ts by design.
import { CONTEXT_WINDOW_PRESETS, parseContextWindow } from "../../scripts/launch-rei.js";

/**
 * The step offered 61440 / 32768 / 16384 / 8192 / 0 — so a machine that can actually hold 100k could
 * not say so, and the user's own tuned setup (contextWindow 100000 on 48 GB of unified memory) was
 * unreachable from the wizard that exists to produce it. Same failure as the reasoning-level step
 * before it: finish the wizard, then correct .env by hand.
 */
describe("the offered presets", () => {
  it("reaches the windows a tuned local setup actually uses", () => {
    expect(CONTEXT_WINDOW_PRESETS).toContain("131072"); // 128k
    expect(CONTEXT_WINDOW_PRESETS).toContain("98304"); //  96k — the practical 100k setup
  });

  it("still offers the small ones, for a model that cannot hold more", () => {
    expect(CONTEXT_WINDOW_PRESETS).toContain("8192");
  });

  it("is ordered largest first, so the list reads as a ceiling coming down", () => {
    const numbers = CONTEXT_WINDOW_PRESETS.map(Number);
    expect([...numbers].sort((a: number, b: number) => b - a)).toEqual(numbers);
  });

  it("does not carry 0 as a preset — it is a separate choice, not a size", () => {
    expect(CONTEXT_WINDOW_PRESETS).not.toContain("0");
  });
});

describe("a custom value", () => {
  it("accepts a number no preset covers", () => {
    expect(parseContextWindow("100000")).toEqual({ ok: true, value: "100000" });
    expect(parseContextWindow("262144")).toEqual({ ok: true, value: "262144" });
    expect(parseContextWindow(" 200000 ")).toEqual({ ok: true, value: "200000" });
  });

  it("rejects what cannot be a window", () => {
    for (const bad of ["", "abc", "-1", "12.5", "0"]) {
      expect(parseContextWindow(bad).ok, bad).toBe(false);
    }
  });

  it("rejects a window too small to run a turn in", () => {
    // Below this the system prompt alone does not fit, so it is a typo, not a choice.
    expect(parseContextWindow("512").ok).toBe(false);
  });

  it("rejects an absurd value, which is always a typo", () => {
    expect(parseContextWindow("100000000").ok).toBe(false);
  });

  it("explains itself when it refuses", () => {
    const r = parseContextWindow("abc");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/number/i);
  });
});
