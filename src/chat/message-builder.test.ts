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

  describe("history is passed through, not rewritten", () => {
    const prose = (headline: string) =>
      `# ${headline}\nfirst detail line\nsecond detail line\nthird detail line`;

    it("keeps an old assistant answer whole", () => {
      // It used to be demoted to "[Earlier answer — gist] <headline>". That rewrite broke the
      // backend's cached prefix — 132s of re-prefill on a real session — to save 5% of the prompt.
      const messages: ChatMessage[] = [
        { role: "system", content: "sys" },
        ...["One", "Two", "Three", "Four", "Five", "Six"].flatMap((h, i) => [
          { role: "user" as const, content: `u${i + 1}` },
          { role: "assistant" as const, content: prose(h) },
        ]),
        { role: "user", content: "latest" },
      ];
      const result = buildMessagesForModel(messages, "ask");
      expect(result.find((m) => m.content.includes("[Earlier answer — gist]"))).toBeUndefined();
      expect(result.find((m) => m.content.includes("# One"))?.content).toContain("third detail line");
    });
  });
});

describe("tool plumbing survives the builder intact", () => {
  const withTools: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "mira el repo" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "run_command", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "grep_code", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "salida 1", tool_call_id: "c1", name: "run_command" },
    { role: "tool", content: "salida 2", tool_call_id: "c2", name: "grep_code" },
    { role: "assistant", content: "Listo." },
    { role: "user", content: "seguimos" },
  ];

  it("does not merge two consecutive tool results into one", () => {
    // Merging drops a tool_call_id, and the provider rejects a result answering nothing.
    const result = buildMessagesForModel(withTools, "agent");
    const tools = result.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.tool_call_id)).toEqual(["c1", "c2"]);
  });

  it("keeps each result's pairing with the request that asked for it", () => {
    const result = buildMessagesForModel(withTools, "agent");
    const requester = result.find((m) => m.role === "assistant" && m.tool_calls);
    expect(requester?.tool_calls?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("never opens the window with an orphan tool result", () => {
    // A trim that cuts between the request and its results would leave one at the head, with no
    // assistant in the window to answer — providers reject that outright.
    const orphaned: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "tool", content: "huerfano", tool_call_id: "gone", name: "run_command" },
      { role: "user", content: "hola" },
    ];
    const result = buildMessagesForModel(orphaned, "agent");
    const firstNonSystem = result.find((m) => m.role !== "system");
    expect(firstNonSystem?.role).not.toBe("tool");
  });
});
