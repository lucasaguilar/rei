import { describe, it, expect } from "vitest";
import { verifyQuote } from "./verify.js";

const SOURCE =
  "Harari argues that information networks are held together by shared stories, not by the " +
  "truth itself. Power flows to those who control the flow of information.";

describe("verifyQuote (deterministic faithfulness)", () => {
  it("verifies an exact (normalized) quote", () => {
    expect(
      verifyQuote("information networks are held together by shared stories", SOURCE),
    ).toBe("verified");
  });

  it("verifies despite whitespace/case differences", () => {
    expect(verifyQuote("  Information   Networks Are Held Together  ", SOURCE)).toBe("verified");
  });

  it("marks a lightly reworded quote (same tokens) as fuzzy", () => {
    expect(
      verifyQuote("networks information are together held by shared stories not", SOURCE),
    ).toBe("fuzzy");
  });

  it("flags a fabricated quote not in the source", () => {
    expect(verifyQuote("Harari cites a 2019 Stanford study on misinformation", SOURCE)).toBe(
      "fabricated",
    );
  });

  it("rejects trivially short quotes as unverifiable", () => {
    expect(verifyQuote("the truth", SOURCE)).toBe("fabricated");
  });
});
