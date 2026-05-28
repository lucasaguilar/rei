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

  it("should discard older history when estimated tokens exceed budget (18000 tokens)", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System content" },
      { role: "user", content: "a".repeat(37000) }, // ~10,000 tokens (will be kept as it is the latest turn)
      { role: "assistant", content: "b".repeat(37000) }, // ~10,000 tokens
      { role: "user", content: "c".repeat(18500) }, // ~5,000 tokens (this is the actual latest message)
    ];
    // History backwards from latest (c):
    // c: ~5,000 tokens (kept)
    // b: ~10,000 tokens (kept, total 15,000)
    // a: ~10,000 tokens (exceeds budget 18000, discarded)
    const result = buildMessagesForModel(messages, "ask");
    expect(result).toHaveLength(4); // [system, user (placeholder), assistant (b), user (c)]
    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("Initialize conversation.");
    expect(result[2].content).toBe("b".repeat(37000));
    expect(result[3].content).toBe("c".repeat(18500));
  });
});
