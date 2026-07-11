import { describe, it, expect } from "vitest";
import { evaluateNoProduce } from "./no-produce-guard.js";

const base = { nudgeAt: 8, bailAt: 12 };

describe("evaluateNoProduce", () => {
  it("resets on a productive turn (an edit/create)", () => {
    const r = evaluateNoProduce({ ...base, toolCallCount: 2, producedDeliverable: true, investigateOnlyTurns: 5 });
    expect(r).toEqual({ investigateOnlyTurns: 0, action: "continue" });
  });

  it("resets on a text turn (no tool calls = deliverable/exit)", () => {
    const r = evaluateNoProduce({ ...base, toolCallCount: 0, producedDeliverable: false, investigateOnlyTurns: 6 });
    expect(r).toEqual({ investigateOnlyTurns: 0, action: "continue" });
  });

  it("counts investigate-only turns and keeps going below the nudge threshold", () => {
    const r = evaluateNoProduce({ ...base, toolCallCount: 1, producedDeliverable: false, investigateOnlyTurns: 3 });
    expect(r).toEqual({ investigateOnlyTurns: 4, action: "continue" });
  });

  it("nudges exactly at nudgeAt", () => {
    const r = evaluateNoProduce({ ...base, toolCallCount: 1, producedDeliverable: false, investigateOnlyTurns: 7 });
    expect(r).toEqual({ investigateOnlyTurns: 8, action: "nudge" });
  });

  it("does not re-nudge after nudgeAt (continues until bail)", () => {
    const r = evaluateNoProduce({ ...base, toolCallCount: 1, producedDeliverable: false, investigateOnlyTurns: 8 });
    expect(r.action).toBe("continue");
    expect(r.investigateOnlyTurns).toBe(9);
  });

  it("abandons at bailAt", () => {
    const r = evaluateNoProduce({ ...base, toolCallCount: 1, producedDeliverable: false, investigateOnlyTurns: 11 });
    expect(r).toEqual({ investigateOnlyTurns: 12, action: "abandon" });
  });

  it("disables steps when thresholds are 0", () => {
    const r = evaluateNoProduce({ nudgeAt: 0, bailAt: 0, toolCallCount: 1, producedDeliverable: false, investigateOnlyTurns: 50 });
    expect(r.action).toBe("continue");
  });
});
