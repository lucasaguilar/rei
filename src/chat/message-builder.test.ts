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

  describe("recency-tiered assistant history (demoteOldAssistantProse)", () => {
    // Multi-line prose (>2 non-empty lines) so demotion actually triggers.
    const prose = (headline: string) =>
      `# ${headline}\nfirst detail line\nsecond detail line\nthird detail line`;

    const findContent = (result: ChatMessage[], needle: string) =>
      result.find((m) => m.content.includes(needle));

    it("demotes OLD assistant prose to a gist but keeps the last 3 verbatim", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: prose("Old One") }, // 5th from end → demote
        { role: "user", content: "u2" },
        { role: "assistant", content: prose("Old Two") }, // 4th from end → demote
        { role: "user", content: "u3" },
        { role: "assistant", content: prose("Keep One") }, // 3rd → verbatim
        { role: "user", content: "u4" },
        { role: "assistant", content: prose("Keep Two") }, // 2nd → verbatim
        { role: "user", content: "u5" },
        { role: "assistant", content: prose("Keep Three") }, // newest → verbatim
        { role: "user", content: "u6" },
      ];
      const result = buildMessagesForModel(messages, "ask");

      // Old ones collapsed to the headline gist (full prose gone from what's sent).
      expect(findContent(result, "[Earlier answer — gist] Old One")).toBeDefined();
      expect(findContent(result, "[Earlier answer — gist] Old Two")).toBeDefined();
      expect(findContent(result, "first detail line")).toBeDefined(); // recent prose survives
      // The recent three keep their full body.
      expect(findContent(result, "Keep One")?.content).toContain("third detail line");
      expect(findContent(result, "Keep Three")?.content).toContain("third detail line");
      // No old full prose leaked through.
      const oldFull = result.filter(
        (m) => m.content.startsWith("# Old"),
      );
      expect(oldFull).toHaveLength(0);
    });

    it("keeps agent action messages verbatim regardless of age", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        {
          role: "assistant",
          content: `<edit>\nchanged code\nmore\nlines</edit>`, // old, but an ACTION
        },
        { role: "user", content: "u2" },
        { role: "assistant", content: prose("Recent A") },
        { role: "user", content: "u3" },
        { role: "assistant", content: prose("Recent B") },
        { role: "user", content: "u4" },
        { role: "assistant", content: prose("Recent C") },
        { role: "user", content: "u5" },
      ];
      const result = buildMessagesForModel(messages, "agent");
      expect(findContent(result, "changed code")).toBeDefined();
      expect(findContent(result, "[Earlier answer — gist]")).toBeUndefined();
    });

    it("keeps planning-sourced plans verbatim regardless of age", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        {
          role: "assistant",
          content: prose("Implementation Plan"),
          sourceMode: "planning",
        },
        { role: "user", content: "u2" },
        { role: "assistant", content: prose("Recent A") },
        { role: "user", content: "u3" },
        { role: "assistant", content: prose("Recent B") },
        { role: "user", content: "u4" },
        { role: "assistant", content: prose("Recent C") },
        { role: "user", content: "u5" },
      ];
      const result = buildMessagesForModel(messages, "planning");
      expect(findContent(result, "Implementation Plan")?.content).toContain(
        "third detail line",
      );
      expect(findContent(result, "[Earlier answer — gist]")).toBeUndefined();
    });

    it("honors REI_VERBATIM_HISTORY_TURNS override (1 = only the newest kept)", () => {
      const saved = process.env.REI_VERBATIM_HISTORY_TURNS;
      process.env.REI_VERBATIM_HISTORY_TURNS = "1";
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: "sys" },
          { role: "user", content: "u1" },
          { role: "assistant", content: prose("Older") }, // 2nd from end → demote
          { role: "user", content: "u2" },
          { role: "assistant", content: prose("Newest") }, // newest → verbatim
          { role: "user", content: "u3" },
        ];
        const result = buildMessagesForModel(messages, "ask");
        expect(findContent(result, "[Earlier answer — gist] Older")).toBeDefined();
        expect(findContent(result, "Newest")?.content).toContain(
          "third detail line",
        );
      } finally {
        if (saved === undefined) delete process.env.REI_VERBATIM_HISTORY_TURNS;
        else process.env.REI_VERBATIM_HISTORY_TURNS = saved;
      }
    });

    it("leaves short prose answers untouched (nothing to gain)", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "Yes." }, // 1-line, old → not demoted
        { role: "user", content: "u2" },
        { role: "assistant", content: prose("Recent A") },
        { role: "user", content: "u3" },
        { role: "assistant", content: prose("Recent B") },
        { role: "user", content: "u4" },
        { role: "assistant", content: prose("Recent C") },
        { role: "user", content: "u5" },
      ];
      const result = buildMessagesForModel(messages, "ask");
      expect(findContent(result, "Yes.")).toBeDefined();
      expect(findContent(result, "[Earlier answer — gist]")).toBeUndefined();
    });
  });
});
