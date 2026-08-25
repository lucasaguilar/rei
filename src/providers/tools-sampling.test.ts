import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmStudioProvider } from "./llm-studio-provider.js";
import { setActiveModelTuning, type ModelTuning } from "../config/model-tuning.js";

/**
 * The agent (tools) path and the chat (ask/planning) path build their request bodies in different
 * files, so they drift. `min_p` and `repetition_penalty` were only ever added to the chat body —
 * a per-model block configuring them was silently inert in AGENT mode, which is exactly where
 * repetition loops bite. These tests pin both paths to the same set of fields.
 */
async function capture(tuning: ModelTuning, tools: boolean): Promise<Record<string, unknown>> {
  setActiveModelTuning(tuning);
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const p = new LlmStudioProvider();
  const msgs = [{ role: "user" as const, content: "hi" }];
  if (tools) await p.completeChatWithTools(msgs, [], {});
  else await p.completeChat(msgs, {});
  return body;
}

beforeEach(() => {
  process.env.LLM_STUDIO_BASE_URL = "http://lmstudio.test/v1";
  process.env.LLM_STUDIO_MODEL = "m";
});
afterEach(() => {
  vi.unstubAllGlobals();
  setActiveModelTuning(undefined);
});

const TUNED: ModelTuning = {
  id: "m", temperature: 1, topP: 0.95, topK: 20, minP: 0.02, repetitionPenalty: 1.1,
};

describe("sampling: agent y chat mandan lo mismo", () => {
  for (const tools of [true, false]) {
    const path = tools ? "tools" : "chat";
    it(`${path}: manda min_p y repetition_penalty cuando estan configurados`, async () => {
      const body = await capture(TUNED, tools);
      expect(body.min_p).toBe(0.02);
      expect(body.repetition_penalty).toBe(1.1);
      expect(body.top_p).toBe(0.95);
      expect(body.top_k).toBe(20);
      expect(body.temperature).toBe(1);
    });

    it(`${path}: lo que no esta configurado NO se inventa`, async () => {
      const body = await capture({ id: "m" }, tools);
      for (const field of ["top_p", "top_k", "min_p", "repetition_penalty"]) {
        expect(body, field).not.toHaveProperty(field);
      }
    });
  }

  it("un 0 explicito se manda como 0 (no se confunde con ausente)", async () => {
    const body = await capture({ id: "m", minP: 0, repetitionPenalty: 1.0 }, true);
    expect(body.min_p).toBe(0);
    expect(body.repetition_penalty).toBe(1.0);
  });
});
