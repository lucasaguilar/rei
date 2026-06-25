import { describe, it, expect } from "vitest";
import { buildMessagesForModel } from "./message-builder.js";
import type { ChatMessage } from "./types.js";

describe("message-builder - buildMessagesForModel", () => {
  it("should keep a system message at the top", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ];
    const result = buildMessagesForModel(messages, "ask");
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
  });

  it("should enforce strict role alternation by merging consecutive same-role messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System content" },
      { role: "user", content: "First user query" },
      { role: "user", content: "Second user query" },
    ];
    const result = buildMessagesForModel(messages, "ask");
    expect(result).toHaveLength(2); // [system, user (merged)]
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("First user query");
    expect(result[1].content).toContain("Second user query");
  });

  it("should prepend a user placeholder if the first non-system message is from the assistant", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System content" },
      { role: "assistant", content: "Assistant response" },
    ];
    const result = buildMessagesForModel(messages, "ask");
    expect(result).toHaveLength(3); // [system, user (placeholder), assistant]
    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("Initialize conversation.");
    expect(result[2].role).toBe("assistant");
  });

  it("discards older history once it exceeds the window-derived token budget", () => {
    // Budget now SCALES with the context window: (window - output) * 0.85.
    // Pick env so the budget is ~15300 → oldest (a) is dropped, b + c kept.
    const savedW = process.env.REI_CONTEXT_WINDOW;
    const savedO = process.env.REI_MAX_OUTPUT_TOKENS;
    process.env.REI_CONTEXT_WINDOW = "26000";
    process.env.REI_MAX_OUTPUT_TOKENS = "8000"; // budget = (26000-8000)*0.85 = 15300
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: "System content" },
        { role: "user", content: "a".repeat(37000) }, // ~9250 tok — oldest, discarded
        { role: "assistant", content: "b".repeat(37000) }, // ~9250 tok — kept
        { role: "user", content: "c".repeat(18500) }, // ~4625 tok — latest, always kept
      ];
      const result = buildMessagesForModel(messages, "ask");
      expect(result).toHaveLength(4); // [system, user placeholder, assistant (b), user (c)]
      expect(result[1].role).toBe("user");
      expect(result[1].content).toBe("Initialize conversation.");
      expect(result[2].content).toBe("b".repeat(37000));
      expect(result[3].content).toBe("c".repeat(18500));
    } finally {
      if (savedW === undefined) delete process.env.REI_CONTEXT_WINDOW;
      else process.env.REI_CONTEXT_WINDOW = savedW;
      if (savedO === undefined) delete process.env.REI_MAX_OUTPUT_TOKENS;
      else process.env.REI_MAX_OUTPUT_TOKENS = savedO;
    }
  });
});
