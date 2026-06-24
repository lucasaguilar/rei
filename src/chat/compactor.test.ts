import { describe, it, expect, vi } from "vitest";
import { compactSession } from "./compactor.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { ChatMessage } from "./types.js";

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
});
