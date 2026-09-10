import { describe, it, expect } from "vitest";
import { addContextReading, publishContextReading } from "./helpers/turn-display.helpers.js";
import { estimateTokens } from "../chat/helpers/token-estimator.js";

type State = { contextTokens?: number; contextWindow?: number; modelLabel?: string };
const state = (over: State = {}): State => ({ ...over });

/**
 * The sticky gauge is published only at the end of a real TURN, on purpose: it is redrawn on every
 * keystroke, and re-estimating the whole history there would put a full token count in the input
 * loop. The cost of that decision was a command — a sub-agent's report, an /ask-document answer —
 * growing the session while the bar kept the previous turn's number, under-reporting at exactly
 * the moment you read it to decide whether to /clear.
 */
describe("addContextReading", () => {
  it("adds what was recorded to the last published reading", () => {
    const s = state({ contextTokens: 1000 });
    addContextReading(s as never, "hello", "world");
    expect(s.contextTokens).toBe(1000 + estimateTokens("hello") + estimateTokens("world"));
  });

  it("moves the gauge for a long report, which is the case that matters", () => {
    const s = state({ contextTokens: 8000 });
    addContextReading(s as never, "/auditor audit @plan.md", "x".repeat(20000));
    expect(s.contextTokens!).toBeGreaterThan(8000);
  });

  it("does nothing when nothing has been measured yet", () => {
    // A bare estimate with no baseline would be displayed as if it were a real reading.
    const s = state({});
    addContextReading(s as never, "hello");
    expect(s.contextTokens).toBeUndefined();
  });

  it("accumulates across several recorded commands", () => {
    const s = state({ contextTokens: 100 });
    addContextReading(s as never, "a".repeat(400));
    const afterFirst = s.contextTokens!;
    addContextReading(s as never, "b".repeat(400));
    expect(s.contextTokens!).toBeGreaterThan(afterFirst);
  });

  it("is replaced, not compounded, by the next real turn's measurement", () => {
    // The increment is an approximation of what the NEXT turn will send; the turn itself then
    // publishes the measured figure, so an over- or under-estimate cannot accumulate.
    const s = state({ contextTokens: 100 });
    addContextReading(s as never, "x".repeat(4000));
    publishContextReading(s as never, 2500, 32768, "qwen");
    expect(s.contextTokens).toBe(2500);
  });

  it("leaves the window and model alone — it only knows about growth", () => {
    const s = state({ contextTokens: 100, contextWindow: 32768, modelLabel: "qwen" });
    addContextReading(s as never, "hello");
    expect(s.contextWindow).toBe(32768);
    expect(s.modelLabel).toBe("qwen");
  });
});
