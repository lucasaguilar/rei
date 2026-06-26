import { describe, it, expect, vi, afterEach } from "vitest";
import { openaiCompleteChatWithTools } from "./openai-tool-caller.js";

const KEYS = [
  "REI_AGENT_TEMPERATURE",
  "REI_AGENT_FREQUENCY_PENALTY",
  "REI_AGENT_PRESENCE_PENALTY",
] as const;

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Calls the tools path with a stubbed fetch and returns the parsed request body. */
async function capturedBody(): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
    body = JSON.parse(init.body);
    return okResponse();
  }) as unknown as typeof fetch;

  await openaiCompleteChatWithTools({
    baseUrl: "http://x",
    headers: {},
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    timeoutMs: 1000,
  });
  return body;
}

describe("openaiCompleteChatWithTools — anti-loop sampling", () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("does NOT decode greedily by default (temp>0 + penalties sent)", async () => {
    for (const k of KEYS) delete process.env[k];
    const body = await capturedBody();
    expect(body.temperature).toBe(0.3);
    expect(body.frequency_penalty).toBe(0.3);
    expect(body.presence_penalty).toBe(0.3);
  });

  it("supports deterministic tool-calls (temp 0) and omits zeroed penalties", async () => {
    process.env.REI_AGENT_TEMPERATURE = "0";
    process.env.REI_AGENT_FREQUENCY_PENALTY = "0";
    process.env.REI_AGENT_PRESENCE_PENALTY = "0";
    const body = await capturedBody();
    expect(body.temperature).toBe(0);
    expect("frequency_penalty" in body).toBe(false);
    expect("presence_penalty" in body).toBe(false);
  });
});
