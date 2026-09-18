import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaProvider } from "./ollama-provider.js";
import { setActiveModelTuning } from "../config/model-tuning.js";

/** The per-model tuning (rei.config.json) must reach ollama's CHAT path (options), like lmstudio. */
describe("ollama chat path applies the active per-model tuning", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    setActiveModelTuning(undefined);
  });

  async function captureOptions(): Promise<Record<string, unknown>> {
    let sent: { options?: Record<string, unknown> } = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider({ baseUrl: "http://x", model: "qwen2.5-coder:14b" });
    await p.completeChat([{ role: "user", content: "hi" }]);
    return sent.options ?? {};
  }

  it("overrides temperature/penalties and adds top_p/top_k from the tuning", async () => {
    setActiveModelTuning({
      id: "qwen2.5-coder",
      temperature: 0.7,
      presencePenalty: 1.5,
      topP: 0.8,
      topK: 20,
    });
    const opts = await captureOptions();
    expect(opts.temperature).toBe(0.7);
    expect(opts.presence_penalty).toBe(1.5);
    expect(opts.top_p).toBe(0.8);
    expect(opts.top_k).toBe(20);
  });

  it("without tuning, keeps env defaults (no top_p/top_k injected)", async () => {
    setActiveModelTuning(undefined);
    const opts = await captureOptions();
    expect(opts).not.toHaveProperty("top_p");
    expect(opts).not.toHaveProperty("top_k");
    expect(opts).toHaveProperty("temperature");
  });
});
