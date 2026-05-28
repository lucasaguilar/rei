import { describe, it, expect } from "vitest";
import { estimateTokens, estimateMessagesTokens } from "./token-estimator.js";

describe("token-estimator", () => {
  describe("estimateTokens", () => {
    it("should return 0 for empty or null text", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("should approximate token counts based on text length", () => {
      // 37 characters should be approx 10 tokens (37 / 3.7 = 10)
      expect(estimateTokens("a".repeat(37))).toBe(10);
    });
  });

  describe("estimateMessagesTokens", () => {
    it("should return 0 for empty message arrays", () => {
      expect(estimateMessagesTokens([])).toBe(0);
    });

    it("should sum estimated tokens across all messages", () => {
      const messages = [
        { content: "a".repeat(37) }, // 10 tokens
        { content: "b".repeat(74) }, // 20 tokens
      ];
      expect(estimateMessagesTokens(messages)).toBe(30);
    });
  });
});
