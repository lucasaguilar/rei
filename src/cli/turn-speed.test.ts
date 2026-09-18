import { describe, it, expect } from "vitest";
import { turnTiming } from "./helpers/turn-timing.helper.js";

/**
 * `Speed: 693000.0 tok/s` for a 693-token answer, with `TTFT: 75.76s` on the same line.
 *
 * The turn reported tokens ÷ (endTime − firstTokenTime). When the response arrives in ONE piece —
 * a non-streaming fallback, or text buffered and flushed at the end — those two instants are the
 * same, the window collapses to the 1ms floor, and the division prints a number a thousand times
 * faster than any local model can generate. The floor was there to avoid Infinity; it turned an
 * impossible number into a merely absurd one.
 *
 * Exercises the real `turnTiming`, which is why it was worth extracting: the first version of this
 * test carried its own copy of the formula, and a test that reimplements what it checks passes
 * happily while the shipped code says 693000.
 */
describe("tokens per second, when the stream was never observed", () => {
  it("does not report a speed no local model can reach", () => {
    // The real shape: 693 tokens, 75.76s of waiting, everything arriving at once at the end.
    const t0 = 1_000_000;
    const { speedText } = turnTiming({
      outputTokens: 693,
      callingModelTime: t0,
      startTime: t0 - 50,
      firstTokenTime: t0 + 75_760,
      endTime: t0 + 75_760,
    });
    expect(speedText).toBe("9.1 tok/s avg"); // 693 / 75.76s — was "693000.0 tok/s"
    expect(speedText, "an averaged number must say so").toContain("avg");
  });

  it("keeps measuring the stream when there WAS one", () => {
    const t0 = 1_000_000;
    const { speedText } = turnTiming({
      outputTokens: 300,
      callingModelTime: t0,
      startTime: t0,
      firstTokenTime: t0 + 2_000, // 2s of prefill…
      endTime: t0 + 12_000, // …then 10s of generation
    });
    expect(speedText).toBe("30.0 tok/s"); // 300 / 10s — prefill excluded, and NOT marked avg
  });

  it("never divides by zero, even if both clocks read the same", () => {
    const t0 = 1_000_000;
    const { speedText } = turnTiming({
      outputTokens: 10,
      callingModelTime: t0,
      startTime: t0,
      firstTokenTime: t0,
      endTime: t0,
    });
    expect(speedText).not.toContain("Infinity");
    expect(speedText).not.toContain("NaN");
  });
});
