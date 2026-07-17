import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compactSession, needsCompaction } from "./compactor.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatMessage } from "./types.js";

describe("needsCompaction (window-aware)", () => {
  const saved = {
    REI_CONTEXT_WINDOW: process.env.REI_CONTEXT_WINDOW,
    REI_MAX_OUTPUT_TOKENS: process.env.REI_MAX_OUTPUT_TOKENS,
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    OLLAMA_NUM_CTX: process.env.OLLAMA_NUM_CTX,
  };
  beforeEach(() => {
    delete process.env.OLLAMA_NUM_CTX;
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.REI_MAX_OUTPUT_TOKENS = "8192";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const msgs = (n: number, chars = 40): ChatMessage[] => {
    const out: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < n; i++)
      out.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(chars) });
    return out;
  };

  it("never compacts a small conversation", () => {
    process.env.REI_CONTEXT_WINDOW = "32768";
    expect(needsCompaction(msgs(6))).toBe(false);
  });

  it("does NOT compact prematurely when well under the window (the bug)", () => {
    // 16 messages but only a few K tokens, 32K window → must NOT compact.
    process.env.REI_CONTEXT_WINDOW = "32768";
    expect(needsCompaction(msgs(16, 200))).toBe(false);
  });

  it("compacts once tokens exceed ~65% of the usable window", () => {
    process.env.REI_CONTEXT_WINDOW = "32768"; // usable = 32768-8192 = 24576; 65% ≈ 16000 tok
    // ~20 messages × ~4000 chars = ~20000 tokens → over threshold
    expect(needsCompaction(msgs(20, 4000))).toBe(true);
  });

  it("large cloud window keeps far more history before compacting", () => {
    process.env.MODEL_PROVIDER = "openrouter"; // getContextWindow → 128000 default
    delete process.env.REI_CONTEXT_WINDOW;
    // Same 20×4000-char history that compacted on 32K → on 128K it does NOT.
    expect(needsCompaction(msgs(20, 4000))).toBe(false);
  });
});

function makeMessages(): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
  }
  return msgs;
}

/** Provider whose completeChat behavior depends on whether a model override is passed. */
function makeProvider(
  completeChat: (m: ChatMessage[], o?: { model?: string }) => Promise<string>,
): ModelProvider {
  return {
    complete: vi.fn(),
    completeChat: vi.fn(completeChat),
  } as unknown as ModelProvider;
}

describe("compactSession resilience", () => {
  const savedTimeout = process.env.COMPACTOR_TIMEOUT_MS;
  beforeEach(() => {
    delete process.env.COMPACTOR_TIMEOUT_MS;
  });
  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.COMPACTOR_TIMEOUT_MS;
    else process.env.COMPACTOR_TIMEOUT_MS = savedTimeout;
  });
  it("falls back to the default model when COMPACTOR_MODEL fails", async () => {
    const provider = makeProvider(async (_m, o) => {
      if (o?.model) throw new Error("No models loaded"); // bad override
      return "FALLBACK SUMMARY";
    });

    const result = await compactSession({
      messages: makeMessages(),
      provider,
      modelOverride: "qwen3:4b", // invalid for the active provider
      force: true,
    });

    const summary = result.find((m) => m.content.includes("CONVERSATION SUMMARY"));
    expect(summary?.content).toContain("FALLBACK SUMMARY");
    // completeChat was called twice: once with the override, once without.
    expect(provider.completeChat).toHaveBeenCalledTimes(2);
  });

  it("keeps the full history (non-fatal) when both attempts fail", async () => {
    const provider = makeProvider(async () => {
      throw new Error("No models loaded");
    });
    const original = makeMessages();

    const result = await compactSession({
      messages: original,
      provider,
      modelOverride: "qwen3:4b",
      force: true,
    });

    // Graceful degradation: original messages returned unchanged.
    expect(result).toEqual(original);
    expect(result.some((m) => m.content.includes("CONVERSATION SUMMARY"))).toBe(false);
  });

  it("does not retry when there is no override and the call fails", async () => {
    const provider = makeProvider(async () => {
      throw new Error("boom");
    });

    const result = await compactSession({
      messages: makeMessages(),
      provider,
      force: true,
    });

    expect(result).toEqual(makeMessages());
    expect(provider.completeChat).toHaveBeenCalledTimes(1); // no fallback retry
  });

  it("times out on override and falls back to default model", async () => {
    vi.useFakeTimers();
    process.env.COMPACTOR_TIMEOUT_MS = "50";

    const provider = makeProvider(async (_m, o) => {
      if (o?.model) {
        // Simulate a cold model that never responds — use setTimeout so fake timers can fire the timeout
        await new Promise((resolve) => setTimeout(resolve, 999_999));
      }
      return "FALLBACK SUMMARY";
    });

    const promise = compactSession({
      messages: makeMessages(),
      provider,
      modelOverride: "qwen3:4b",
      force: true,
    });

    // Fire all pending timers so the timeout fires and fallback runs
    await vi.runAllTimersAsync();

    const result = await promise;

    const summary = result.find((m) => m.content.includes("CONVERSATION SUMMARY"));
    expect(summary?.content).toContain("FALLBACK SUMMARY");
    expect(provider.completeChat).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("degrades to full history when both override and default time out", async () => {
    vi.useFakeTimers();
    process.env.COMPACTOR_TIMEOUT_MS = "50";

    const provider = makeProvider(async () => {
      // Both calls hang forever — use setTimeout so fake timers can fire the timeout
      await new Promise((resolve) => setTimeout(resolve, 999_999));
    });
    const original = makeMessages();

    const promise = compactSession({
      messages: original,
      provider,
      modelOverride: "qwen3:4b",
      force: true,
    });

    // Fire all pending timers — both timeouts fire, degradation kicks in
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result).toEqual(original);
    expect(result.some((m) => m.content.includes("CONVERSATION SUMMARY"))).toBe(false);

    vi.useRealTimers();
  });
});
