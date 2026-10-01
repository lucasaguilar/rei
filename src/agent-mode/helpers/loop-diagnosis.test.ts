import { describe, it, expect } from "vitest";
import { diagnoseLoop, looksLooping } from "./loop-guard.js";

/**
 * The guard logged THAT it cut a response, never WHAT it cut:
 *   `[loop-guard] repetition cut (1/1) — dropping the looping output and retrying once`
 *
 * So a false positive and a real loop read identically after the fact, and the only way to judge the
 * guard was to turn it off and see whether the answer had been fine. Measured over one workspace's
 * log: 230 cuts in 1855 turns, concentrated on particular days — which is the shape of a
 * configuration problem, but nothing recorded said so.
 */
/** Sixty words of VARIED prose: no phrase repeats inside it, so only the block-level detector can
 *  see anything. A block that repeats a phrase internally trips the tight detector first. */
const BLOCK = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + " ";
/** Filler that never repeats either, so the only repetition in the fixture is the block itself. */
const FILLER = Array.from({ length: 200 }, (_, i) => `filler${i}`).join(" ") + " ";

describe("diagnoseLoop", () => {
  it("returns null for ordinary prose", () => {
    expect(diagnoseLoop("A short answer that says one thing once and then stops.")).toBeNull();
  });

  it("names the phrase that repeats back to back, and how often", () => {
    const d = diagnoseLoop(`Here is the plan. ${"I will check the file. ".repeat(6)} Done.`);
    expect(d?.kind).toBe("phrase");
    expect(d?.excerpt).toContain("check the file");
    expect(d?.occurrences).toBeGreaterThanOrEqual(4);
  });

  it("names the block for a long paragraph cycle", () => {
    // A 60-word span, verbatim, three times, separated by text that varies — the shape a cycling
    // decoder produces and a parallel document does not.
    const d = diagnoseLoop(`${BLOCK}${FILLER}${BLOCK}${FILLER}${BLOCK}`);
    expect(d?.kind).toBe("cycle");
    expect(d?.occurrences).toBeGreaterThanOrEqual(3);
    expect(d?.excerpt).toContain("word0");
  });

  it("reports how much text it scanned, so a cut on a huge buffer reads differently", () => {
    const d = diagnoseLoop(`Here is the plan. ${"I will check the file. ".repeat(6)}`);
    expect(d?.words).toBeGreaterThan(12);
  });

  it("keeps the excerpt short enough for a log line", () => {
    const d = diagnoseLoop(`Here is the plan. ${"I will check the file. ".repeat(20)}`);
    expect(d!.excerpt.length).toBeLessThanOrEqual(200);
  });

  it("agrees with looksLooping, which is now a thin wrapper over it", () => {
    const looping = `Here is the plan. ${"I will check the file. ".repeat(6)}`;
    expect(looksLooping(looping)).toBe(diagnoseLoop(looping) !== null);
    expect(looksLooping("one calm sentence")).toBe(false);
  });

  it("stays silent when the guard is switched off", () => {
    process.env.REI_LOOP_GUARD = "off";
    try {
      expect(looksLooping(`x. ${"I will check the file. ".repeat(6)}`)).toBe(false);
    } finally {
      delete process.env.REI_LOOP_GUARD;
    }
  });
});
