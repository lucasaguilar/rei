import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OmlxProvider } from "./omlx-provider.js";
import { OpenAiCompatProvider } from "./openai-compat-provider.js";
import { LlmStudioProvider } from "./llm-studio-provider.js";
import { MtplxProvider } from "./mtplx-provider.js";

/**
 * Turning thinking OFF is not a reasoning LEVEL, and on a Qwen-style template the two are different
 * doors. Measured against oMLX with Qwen3.8 (medians of 3 runs, chars of reasoning_content):
 *
 *   reasoning_effort: none                          → 279   (still thinking)
 *   chat_template_kwargs {reasoning_effort: none}   → 280   (still thinking)
 *   chat_template_kwargs {enable_thinking: false}   →   0   ← the only real switch
 *
 * And which backends may receive that field is DECLARED, never probed: one request carrying
 * chat_template_kwargs to LM Studio returned a fatal backend exception and left the server down.
 */
const saved = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("OMLX_") || k.startsWith("OPENAI_COMPAT_") || k.includes("TEMPLATE_KWARGS")) {
      delete process.env[k];
    }
  }
});
afterEach(() => {
  process.env = { ...saved };
});

/** templateKwargs is protected — this is the payload the provider would put in the request body. */
const kwargsOf = (p: object, level?: string) =>
  (p as unknown as { templateKwargs(l?: string): Record<string, unknown> | undefined })
    .templateKwargs(level);

describe("the off switch reaches the backends that support it", () => {
  it("oMLX turns thinking off with enable_thinking:false", () => {
    expect(kwargsOf(new OmlxProvider(), "none")).toEqual({ enable_thinking: false });
  });

  it("…and still sends a real level as a level", () => {
    expect(kwargsOf(new OmlxProvider(), "low")).toEqual({ reasoning_effort: "low" });
    expect(kwargsOf(new OmlxProvider(), "xhigh")).toEqual({ reasoning_effort: "xhigh" });
  });

  it("mtplx keeps the same bridge", () => {
    expect(kwargsOf(new MtplxProvider(), "none")).toEqual({ enable_thinking: false });
  });

  it("sends nothing when no level was asked for", () => {
    expect(kwargsOf(new OmlxProvider(), undefined)).toBeUndefined();
  });
});

describe("backends that do NOT forward them are never sent kwargs", () => {
  it("LM Studio gets none — it answered a fatal error and went down", () => {
    expect(kwargsOf(new LlmStudioProvider(), "none")).toBeUndefined();
    expect(kwargsOf(new LlmStudioProvider(), "low")).toBeUndefined();
  });

  it("an unknown OpenAI-compatible endpoint is assumed not to forward them", () => {
    expect(kwargsOf(new OpenAiCompatProvider(), "none")).toBeUndefined();
  });

  it("…until you say it does", () => {
    process.env.OPENAI_COMPAT_TEMPLATE_KWARGS = "true";
    expect(kwargsOf(new OpenAiCompatProvider(), "none")).toEqual({ enable_thinking: false });
  });

  it("and oMLX can be switched off if its behaviour ever changes", () => {
    process.env.OMLX_TEMPLATE_KWARGS = "false";
    expect(kwargsOf(new OmlxProvider(), "none")).toBeUndefined();
  });
});

describe("oMLX defaults", () => {
  it("points at the port oMLX serves on", () => {
    expect((new OmlxProvider() as unknown as { baseUrl: string }).baseUrl).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });

  it("takes its own env, not LM Studio's", () => {
    process.env.OMLX_BASE_URL = "http://otra-maquina:8000/v1/";
    process.env.OMLX_API_KEY = "abc";
    const p = new OmlxProvider() as unknown as { baseUrl: string; apiKey: string };
    expect(p.baseUrl).toBe("http://otra-maquina:8000/v1"); // trailing slash normalised away
    expect(p.apiKey).toBe("abc");
  });
});
