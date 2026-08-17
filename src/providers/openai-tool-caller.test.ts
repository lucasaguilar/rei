import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ToolCallAccumulator,
  openaiStreamChatWithTools,
  openaiCompleteChatWithTools,
  mergeLeadingSystemMessages,
} from "./openai-tool-caller.js";
import type { ToolStreamDelta } from "./model-provider.js";
import type { ChatMessage } from "../chat/types.js";

describe("mergeLeadingSystemMessages", () => {
  const sys = (c: string): ChatMessage => ({ role: "system", content: c });
  const user = (c: string): ChatMessage => ({ role: "user", content: c });

  it("merges two leading system messages into one (content concatenated)", () => {
    const out = mergeLeadingSystemMessages([sys("base"), sys("directive"), user("hi")]);
    expect(out).toEqual([sys("base\n\ndirective"), user("hi")]);
  });

  it("leaves a single leading system untouched", () => {
    const msgs = [sys("base"), user("hi")];
    expect(mergeLeadingSystemMessages(msgs)).toEqual(msgs);
  });

  it("is a no-op when there is no system message", () => {
    const msgs = [user("hi")];
    expect(mergeLeadingSystemMessages(msgs)).toEqual(msgs);
  });

  it("only merges LEADING system messages (a later system is left in place)", () => {
    const msgs = [sys("base"), user("hi"), sys("mid")];
    expect(mergeLeadingSystemMessages(msgs)).toEqual(msgs);
  });

  it("preserves the first message's other fields when merging", () => {
    const first: ChatMessage = { role: "system", content: "a", sourceMode: "agent" };
    const out = mergeLeadingSystemMessages([first, sys("b"), user("x")]);
    expect(out[0]).toEqual({ role: "system", content: "a\n\nb", sourceMode: "agent" });
  });
});

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
      // Final usage-only chunk (choices empty) — what OpenAI sends with stream_options.include_usage.
      'data: {"usage":{"prompt_tokens":120,"completion_tokens":45},"choices":[]}\n',
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
    // Usage from the final chunk survives even though its choices array was empty.
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 45 });
  });

  it("requests stream_options.include_usage on the wire (and can strip it via omitParams)", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ];
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return sseResponse(chunks);
    }) as unknown as typeof fetch;

    await openaiStreamChatWithTools(
      { baseUrl: "http://x/v1", headers: {}, model: "m", messages: [], tools: [], timeoutMs: 1000 },
      () => {},
    );
    expect(sentBody).toHaveProperty("stream_options", { include_usage: true });

    // A backend that 400s on stream_options can strip it — usage then just stays absent.
    sentBody = {};
    await openaiStreamChatWithTools(
      { baseUrl: "http://x/v1", headers: {}, model: "m", messages: [], tools: [], timeoutMs: 1000, omitParams: ["stream_options"] },
      () => {},
    );
    expect(sentBody).not.toHaveProperty("stream_options");
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

describe("openaiCompleteChatWithTools request body — omitParams (mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  const prevFreq = process.env.REI_AGENT_FREQUENCY_PENALTY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (prevFreq === undefined) delete process.env.REI_AGENT_FREQUENCY_PENALTY;
    else process.env.REI_AGENT_FREQUENCY_PENALTY = prevFreq;
  });

  function okJson() {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  }

  async function capture(omitParams?: string[]): Promise<Record<string, unknown>> {
    process.env.REI_AGENT_FREQUENCY_PENALTY = "0.3"; // ensure penalties are present to be stripped
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return okJson();
    }) as unknown as typeof fetch;
    await openaiCompleteChatWithTools({
      baseUrl: "http://x/v1",
      headers: {},
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 1000,
      options: { reasoningEffort: "low" },
      omitParams,
    });
    return sent;
  }

  it("sends penalties + reasoning_effort by default (no omitParams)", async () => {
    const body = await capture();
    expect(body).toHaveProperty("frequency_penalty");
    expect(body).toHaveProperty("reasoning_effort", "low");
  });

  it("includes top_p/top_k in the body only when the active model tuning sets them", async () => {
    const { setActiveModelTuning } = await import("../config/model-tuning.js");
    const withoutTuning = await capture();
    expect(withoutTuning).not.toHaveProperty("top_p");
    expect(withoutTuning).not.toHaveProperty("top_k");

    setActiveModelTuning({ id: "m", topP: 0.8, topK: 20 });
    const withTuning = await capture();
    setActiveModelTuning(undefined);
    expect(withTuning).toHaveProperty("top_p", 0.8);
    expect(withTuning).toHaveProperty("top_k", 20);
  });

  it("strips exactly the omitted fields (Gemini compat), leaving the rest intact", async () => {
    const body = await capture([
      "frequency_penalty",
      "presence_penalty",
      "reasoning_effort",
    ]);
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
    expect(body).not.toHaveProperty("reasoning_effort");
    // untouched fields survive
    expect(body).toHaveProperty("model", "m");
    expect(body).toHaveProperty("tool_choice", "auto");
    expect(body).toHaveProperty("max_tokens");
  });

  it("omits stream_options from the NON-streaming body (usage comes in the response, not a request flag)", async () => {
    const body = await capture();
    expect(body).not.toHaveProperty("stream_options");
  });
});

describe("openaiCompleteChatWithTools usage capture (mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function call(body: Record<string, unknown>) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    return openaiCompleteChatWithTools({
      baseUrl: "http://x/v1",
      headers: {},
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 1000,
    });
  }

  it("maps the backend usage block to TokenUsage", async () => {
    const r = await call({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 150, completion_tokens: 30 },
    });
    expect(r.usage).toEqual({ promptTokens: 150, completionTokens: 30 });
  });

  it("leaves usage absent when the backend reports none", async () => {
    const r = await call({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
    expect(r.usage).toBeUndefined();
  });

  it("drops invalid counts (negative / non-finite) and keeps the valid half", async () => {
    const r = await call({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: -5, completion_tokens: 12 },
    });
    expect(r.usage).toEqual({ completionTokens: 12 });

    const allBad = await call({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: Number.NaN, completion_tokens: -1 },
    });
    expect(allBad.usage).toBeUndefined();
  });
});
