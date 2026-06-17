import { describe, it, expect } from "vitest";
import { streamTurnWithInterception } from "./token-streamer.js";
import type { ModelProvider } from "../../providers/model-provider.js";

describe("token-streamer streamTurnWithInterception", () => {
  it("streams prose immediately and buffers edit tags", async () => {
    const chunks = [
      "Here is ",
      "the plan.\n",
      "<edit file=",
      '"agent.ts">\n',
      "search content\n",
      "</edit>\n",
      "Let me know.",
    ];

    const mockProvider = {
      streamChat: () => {
        return (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })();
      },
    } as unknown as ModelProvider;

    const yieldedChunks: { type: string; content: string }[] = [];
    const result = await streamTurnWithInterception({
      provider: mockProvider,
      messages: [],
      mode: "agent",
      onChunk: (event) => {
        yieldedChunks.push(event);
      },
    });

    // Check full returned string
    expect(result).toBe("Here is the plan.\n<edit file=\"agent.ts\">\nsearch content\n</edit>\nLet me know.");

    // Check filtered chunks: should contain only prose and one status chunk
    expect(yieldedChunks).toEqual([
      { type: "text", content: "Here is " },
      { type: "text", content: "the plan.\n" },
      { type: "status", content: "\n\x1b[33m🛠️  [REI] Proposing Search & Replace edits...\x1b[0m\n" },
      { type: "text", content: "\n" },
      { type: "text", content: "Let me know." },
    ]);
  });

  it("falls back to completeChat if streamChat is not supported", async () => {
    const mockProvider = {
      completeChat: async () => {
        return "I will update it.\n<create file=\"new.ts\">\nsome code\n</create>\nDone.";
      },
    } as unknown as ModelProvider;

    const yieldedChunks: { type: string; content: string }[] = [];
    const result = await streamTurnWithInterception({
      provider: mockProvider,
      messages: [],
      onChunk: (event) => {
        yieldedChunks.push(event);
      },
    });

    expect(result).toBe("I will update it.\n<create file=\"new.ts\">\nsome code\n</create>\nDone.");

    // Fallback splits prose
    expect(yieldedChunks).toEqual([
      { type: "text", content: "I will update it.\n\nDone." },
    ]);
  });

  it("strips leaked native <tool_call> syntax (ask/planning), keeps prose", async () => {
    const chunks = [
      "Te explico.\n",
      "<tool_call>\n<function=execute_command>\n</function>\n</tool_call>\n",
      "Las skills usan use_skill.",
    ];
    const mockProvider = {
      streamChat: () =>
        (async function* () {
          for (const c of chunks) yield c;
        })(),
    } as unknown as ModelProvider;

    let text = "";
    await streamTurnWithInterception({
      provider: mockProvider,
      messages: [],
      mode: "ask",
      onChunk: (e) => {
        if (e.type === "text") text += e.content;
      },
    });

    expect(text).not.toMatch(/tool_call|function=/);
    expect(text).toContain("Te explico");
    expect(text).toContain("use_skill");
  });
});
