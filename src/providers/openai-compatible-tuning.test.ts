import { describe, it, expect, vi, afterEach } from "vitest";
import { LmStudioProvider } from "./lm-studio-provider.js";
import { setActiveModelTuning } from "../config/model-tuning.js";

/**
 * The per-model tuning (rei.config.json) must reach the CHAT path (fetchChat) too — this is what
 * makes it control ask-document / direct completeChat, not just the agent tools path.
 */
describe("fetchChat applies the active per-model tuning", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setActiveModelTuning(undefined);
  });

  async function captureBody(): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new LmStudioProvider({
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "qwen/qwen3.6-27b",
    });
    await provider.completeChat([{ role: "user", content: "hi" }]);
    return sent;
  }

  it("overrides temperature/penalties and adds top_p/top_k from the tuning", async () => {
    setActiveModelTuning({
      id: "qwen3.6-27b",
      temperature: 0.7,
      presencePenalty: 1.5,
      topP: 0.8,
      topK: 20,
    });
    const body = await captureBody();
    expect(body.temperature).toBe(0.7);
    expect(body.presence_penalty).toBe(1.5);
    expect(body.top_p).toBe(0.8);
    expect(body.top_k).toBe(20);
  });

  it("without active tuning, top_p/top_k are absent (provider defaults untouched)", async () => {
    setActiveModelTuning(undefined);
    const body = await captureBody();
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).toHaveProperty("temperature");
  });
});
