import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compactorModelFor, compactorTimeoutMs, compactSession, needsCompaction } from "./compactor.js";
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

    const { messages: result } = await compactSession({
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

    const { messages: result } = await compactSession({
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

    const { messages: result } = await compactSession({
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

    const { messages: result } = await promise;

    const summary = result.find((m) => m.content.includes("CONVERSATION SUMMARY"));
    expect(summary?.content).toContain("FALLBACK SUMMARY");
    expect(provider.completeChat).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("degrades to full history when both override and default time out", async () => {
    vi.useFakeTimers();
    process.env.COMPACTOR_TIMEOUT_MS = "50";

    const provider = makeProvider(async (): Promise<string> => {
      // Both calls hang forever — use setTimeout so fake timers can fire the timeout
      await new Promise((resolve) => setTimeout(resolve, 999_999));
      return ""; // unreachable: the timeout always fires first. Present so the mock matches the
      // provider's signature — without it the file was the one standing typecheck error, which is
      // exactly the kind of "known failure" that makes a red CI easy to ignore.
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

    const { messages: result } = await promise;

    expect(result).toEqual(original);
    expect(result.some((m) => m.content.includes("CONVERSATION SUMMARY"))).toBe(false);

    vi.useRealTimers();
  });
});

/**
 * Compaction fails softly so a bad summary never kills a turn. "Softly" used to mean "silently":
 * `/compact` reported `Session compacted (model: qwen/qwen3-4b). 117 → 117 messages` over a 404,
 * with the proof that nothing happened printed in its own success message. The reason now travels
 * back with the messages so the caller can tell the two apart.
 */
describe("a compaction that did not happen says so", () => {
  const history = (): ChatMessage[] => [
    { role: "system", content: "sys" },
    ...Array.from({ length: 20 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `mensaje ${i} `.repeat(40),
    })),
  ];

  it("reports the backend's reason when the summary call fails", async () => {
    const provider = {
      completeChat: vi.fn().mockRejectedValue(new Error("404: Model 'qwen/qwen3-4b' not found")),
    } as unknown as ModelProvider;
    const messages = history();
    const out = await compactSession({ messages, provider, force: true });
    expect(out.skipped).toContain("not found");
    expect(out.messages).toBe(messages); // untouched, so the turn can go on
  });

  it("says nothing was compacted when the threshold is not reached", async () => {
    const provider = { completeChat: vi.fn() } as unknown as ModelProvider;
    const out = await compactSession({ messages: history(), provider });
    expect(out.skipped).toContain("threshold");
    expect(provider.completeChat).not.toHaveBeenCalled();
  });

  it("leaves `skipped` unset when it really did compact", async () => {
    const provider = {
      completeChat: vi.fn().mockResolvedValue("RESUMEN"),
    } as unknown as ModelProvider;
    const messages = history();
    const out = await compactSession({ messages, provider, force: true });
    expect(out.skipped).toBeUndefined();
    expect(out.messages.length).toBeLessThan(messages.length);
  });
});

/**
 * On a local backend the summarizer should be the model ALREADY in memory. Falling back to the
 * provider's default meant `<PREFIX>_MODEL` — the ask/planning model, not the agent's and not one
 * chosen with `/model` — so compacting could load a second model, or ask for one the backend does
 * not have: COMPACTOR_MODEL=qwen/qwen3-4b (an LM Studio id) against oMLX returned 404, and the
 * 60s timeout on that path then killed the retry too.
 */
describe("who writes the summary", () => {
  const saved = process.env.COMPACTOR_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.COMPACTOR_MODEL;
    else process.env.COMPACTOR_MODEL = saved;
  });

  it("uses the session's own model when nothing is configured", () => {
    delete process.env.COMPACTOR_MODEL;
    expect(compactorModelFor("Qwen3.8-27B-MLX-4bit")).toBe("Qwen3.8-27B-MLX-4bit");
  });

  it("still honours an explicit COMPACTOR_MODEL", () => {
    process.env.COMPACTOR_MODEL = "qwen3:4b";
    expect(compactorModelFor("Qwen3.8-27B-MLX-4bit")).toBe("qwen3:4b");
  });

  it("treats an empty or whitespace override as unset", () => {
    for (const blank of ["", "   "]) {
      process.env.COMPACTOR_MODEL = blank;
      expect(compactorModelFor("active-model"), JSON.stringify(blank)).toBe("active-model");
    }
  });

  it("returns undefined when there is nothing to go on", () => {
    delete process.env.COMPACTOR_MODEL;
    expect(compactorModelFor(undefined)).toBeUndefined();
  });
});

/**
 * The timeout used to be a flat 60s, which is a cloud number. Locally the summarizer has to prefill
 * the whole history first — 176s for 55k tokens, measured — so the compaction that mattered most,
 * on a session big enough to need one, was the one certain to be cut off. It died at 60s, the error
 * was swallowed, and the history came back untouched.
 */
describe("the summary gets time proportional to what it must read", () => {
  const saved = process.env.COMPACTOR_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.COMPACTOR_TIMEOUT_MS;
    else process.env.COMPACTOR_TIMEOUT_MS = saved;
  });

  it("gives a 44k-token history minutes, not one", () => {
    delete process.env.COMPACTOR_TIMEOUT_MS;
    const ms = compactorTimeoutMs(44_000 * 4); // chars
    expect(ms).toBeGreaterThan(120_000); // the old flat 60s would have killed this one
    expect(ms).toBeLessThan(900_000);
  });

  it("does not make a small session wait for nothing", () => {
    delete process.env.COMPACTOR_TIMEOUT_MS;
    expect(compactorTimeoutMs(4_000)).toBeLessThan(45_000);
  });

  it("grows with the history", () => {
    delete process.env.COMPACTOR_TIMEOUT_MS;
    expect(compactorTimeoutMs(200_000)).toBeGreaterThan(compactorTimeoutMs(20_000));
  });

  it("caps, because past some point the backend is wedged and not slow", () => {
    delete process.env.COMPACTOR_TIMEOUT_MS;
    expect(compactorTimeoutMs(100_000_000)).toBe(900_000);
  });

  it("an explicit COMPACTOR_TIMEOUT_MS still wins", () => {
    process.env.COMPACTOR_TIMEOUT_MS = "50";
    expect(compactorTimeoutMs(44_000 * 4)).toBe(50);
  });

  it("ignores a junk override instead of timing out instantly", () => {
    for (const junk of ["", "abc", "0", "-1"]) {
      process.env.COMPACTOR_TIMEOUT_MS = junk;
      expect(compactorTimeoutMs(40_000), junk).toBeGreaterThan(30_000);
    }
  });
});

/**
 * `/compact` reported `Session compacted (model: qwen/qwen3-4b)` for a summary that model never
 * wrote — it had 404'd and the provider's own model did the work (or nothing did). The result now
 * carries who actually wrote it, so the command can credit the right one.
 */
describe("the result names the model that wrote the summary", () => {
  const history = (): ChatMessage[] => [
    { role: "system", content: "sys" },
    ...Array.from({ length: 20 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `mensaje ${i} `.repeat(40),
    })),
  ];

  it("credits the override when the override worked", async () => {
    const provider = {
      completeChat: vi.fn().mockResolvedValue("RESUMEN"),
      getModel: () => "modelo-del-provider",
    } as unknown as ModelProvider;
    const out = await compactSession({
      messages: history(),
      provider,
      modelOverride: "compactador-chico",
      force: true,
    });
    expect(out.model).toBe("compactador-chico");
  });

  it("credits the fallback when the override failed", async () => {
    const completeChat = vi
      .fn()
      .mockRejectedValueOnce(new Error("404: Model not found"))
      .mockResolvedValueOnce("RESUMEN");
    const provider = {
      completeChat,
      getModel: () => "modelo-del-provider",
    } as unknown as ModelProvider;
    const out = await compactSession({
      messages: history(),
      provider,
      modelOverride: "compactador-inexistente",
      force: true,
    });
    expect(out.skipped).toBeUndefined();
    expect(out.model).toBe("modelo-del-provider"); // NOT the one that 404'd
  });

  it("credits the provider's model when nothing was configured", async () => {
    const provider = {
      completeChat: vi.fn().mockResolvedValue("RESUMEN"),
      getModel: () => "modelo-del-provider",
    } as unknown as ModelProvider;
    const out = await compactSession({ messages: history(), provider, force: true });
    expect(out.model).toBe("modelo-del-provider");
  });
});
