import { describe, it, expect, vi, afterEach } from "vitest";
import { callModel } from "./call-model.js";
import type { ModelProvider, ChatCompletionWithTools } from "../../providers/model-provider.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function makeResult(over: Partial<ChatCompletionWithTools>): ChatCompletionWithTools {
  return {
    content: "",
    reasoning: "",
    finishReason: "stop",
    toolCalls: [],
    ...over,
  } as ChatCompletionWithTools;
}

describe("callModel", () => {
  const saved = process.env.REI_PRESERVE_THINKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.REI_PRESERVE_THINKING;
    else process.env.REI_PRESERVE_THINKING = saved;
    vi.restoreAllMocks();
  });

  it("invokes completeChatWithTools with model + reasoningEffort and returns its result", async () => {
    const result = makeResult({ content: "hi" });
    const completeChatWithTools = vi.fn(
      async (_m: unknown, _t: unknown, _o: unknown) => result,
    );
    const provider = { completeChatWithTools } as unknown as ModelProvider;

    const out = await callModel({
      provider,
      messages: [{ role: "user", content: "q" }],
      tools: [],
      modelOverride: "m1",
      reasoningEffort: "none",
      logger: fakeLogger,
    });

    expect(out).toBe(result);
    expect(completeChatWithTools).toHaveBeenCalledTimes(1);
    expect(completeChatWithTools.mock.calls[0][2]).toEqual({
      model: "m1",
      reasoningEffort: "none",
    });
  });

  it("surfaces the model's reasoning live via onChunk", async () => {
    const provider = {
      completeChatWithTools: vi.fn(async () => makeResult({ reasoning: "thinking…" })),
    } as unknown as ModelProvider;
    const chunks: Array<{ type: string; content: string }> = [];

    await callModel({
      provider,
      messages: [],
      tools: [],
      logger: fakeLogger,
      onChunk: (e) => chunks.push(e),
    });

    expect(chunks).toEqual([{ type: "thinking", content: "thinking…\n" }]);
  });

  it("does NOT emit a thinking chunk when reasoning is empty", async () => {
    const provider = {
      completeChatWithTools: vi.fn(async () => makeResult({ content: "answer" })),
    } as unknown as ModelProvider;
    const chunks: unknown[] = [];

    await callModel({
      provider,
      messages: [],
      tools: [],
      logger: fakeLogger,
      onChunk: (e) => chunks.push(e),
    });

    expect(chunks).toEqual([]);
  });
});
