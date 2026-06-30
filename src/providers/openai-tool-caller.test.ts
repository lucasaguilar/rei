import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ToolCallAccumulator,
  openaiStreamChatWithTools,
} from "./openai-tool-caller.js";
import type { ToolStreamDelta } from "./model-provider.js";

/**
 * Unit tests for the streamed-tool-call accumulator (the hard part of the streaming spike): id/name
 * arrive in the first delta for an index, arguments stream as fragments to concatenate per index.
 * Pure — no network. See docs/stream-tools-spike.md.
 */
describe("ToolCallAccumulator", () => {
  it("concatenates content and reasoning fragments and returns the live piece", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.push({ reasoning_content: "Let me " })).toEqual({
      text: "",
      reasoning: "Let me ",
    });
    expect(acc.push({ reasoning_content: "think." })).toEqual({
      text: "",
      reasoning: "think.",
    });
    expect(acc.push({ content: "Hello" })).toEqual({ text: "Hello", reasoning: "" });
    acc.push({ content: " world" });

    const r = acc.result();
    expect(r.content).toBe("Hello world");
    expect(r.reasoning).toBe("Let me think.");
  });

  it("accepts reasoning under either `reasoning_content` or `reasoning`", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ reasoning: "alt-field" });
    expect(acc.result().reasoning).toBe("alt-field");
  });

  it("assembles a tool call from streamed fragments (id/name first, args concatenated)", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_files" } }] });
    acc.push({ tool_calls: [{ index: 0, function: { arguments: '{"paths"' } }] });
    acc.push({ tool_calls: [{ index: 0, function: { arguments: ': ["a.ts"]}' } }] });

    const r = acc.result();
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read_files", arguments: '{"paths": ["a.ts"]}' },
    });
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ paths: ["a.ts"] });
    // no explicit finish_reason but tool calls present → "tool_calls"
    expect(r.finishReason).toBe("tool_calls");
  });

  it("accumulates MULTIPLE tool calls by index, sorted", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ tool_calls: [{ index: 1, id: "b", function: { name: "second", arguments: "{}" } }] });
    acc.push({ tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: "{}" } }] });

    const r = acc.result();
    expect(r.toolCalls.map((t) => t.function.name)).toEqual(["first", "second"]);
    expect(r.toolCalls.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("defaults empty arguments to {} and drops calls missing id or name", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ tool_calls: [{ index: 0, id: "ok", function: { name: "go" } }] }); // no args
    acc.push({ tool_calls: [{ index: 1, function: { name: "noId", arguments: "{}" } }] }); // no id
    acc.push({ tool_calls: [{ index: 2, id: "noName", function: { arguments: "{}" } }] }); // no name

    const r = acc.result();
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function).toEqual({ name: "go", arguments: "{}" });
  });

  it("captures an explicit finish_reason and defaults to 'stop' for a plain answer", () => {
    const withReason = new ToolCallAccumulator();
    withReason.push({ content: "done" }, "stop");
    expect(withReason.result().finishReason).toBe("stop");

    const plain = new ToolCallAccumulator();
    plain.push({ content: "just text" });
    const r = plain.result();
    expect(r.finishReason).toBe("stop");
    expect(r.toolCalls).toEqual([]);
    expect(r.reasoning).toBeUndefined(); // omitted when empty
  });
});

/** Builds a Response whose body streams the given SSE text chunks (as a real ReadableStream). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("openaiStreamChatWithTools (SSE end-to-end, mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads SSE frames (incl. one split across chunks), surfaces deltas live, assembles result", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
      // a single SSE frame split across two network chunks (tests cross-chunk buffering):
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","fun',
      'ction":{"name":"read_files","arguments":"{}"}}]}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ];
    globalThis.fetch = vi.fn(async () => sseResponse(chunks)) as unknown as typeof fetch;

    const deltas: ToolStreamDelta[] = [];
    const result = await openaiStreamChatWithTools(
      {
        baseUrl: "http://x/v1",
        headers: {},
        model: "m",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      },
      (d) => deltas.push(d),
    );

    // Live fragments surfaced in order (tool-call deltas carry no text/reasoning, so none emitted).
    expect(deltas).toEqual([
      { type: "reasoning", content: "Thinking" },
      { type: "text", content: "Hi" },
    ]);
    // Final assembled result.
    expect(result.content).toBe("Hi");
    expect(result.reasoning).toBe("Thinking");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_files");
  });

  it("throws on a non-ok response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("boom", { status: 500, statusText: "Server Error" }),
    ) as unknown as typeof fetch;
    await expect(
      openaiStreamChatWithTools(
        { baseUrl: "http://x/v1", headers: {}, model: "m", messages: [], tools: [], timeoutMs: 1000 },
        () => {},
      ),
    ).rejects.toThrow(/Tool streaming request failed/);
  });
});
