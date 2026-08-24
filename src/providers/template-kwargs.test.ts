import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MtplxProvider } from "./mtplx-provider.js";
import { LlmStudioProvider } from "./llm-studio-provider.js";

/**
 * Qwen3.8's reasoning level is a chat-TEMPLATE variable, not an engine param, so it only takes
 * effect if the backend forwards it into the Jinja context. MTPLX does (verified live:
 * `enable_thinking:false` drove reasoning_tokens to 0); LM Studio does not (an invalid value never
 * reaches the template's raise_exception) and needs a model.yaml customField instead. These tests
 * pin the wire format so the distinction can't regress silently.
 */
function captureBody() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return bodies;
}

beforeEach(() => {
  process.env.MTPLX_BASE_URL = "http://mtplx.test/v1";
  process.env.MTPLX_MODEL = "mtplx-model";
  process.env.LLM_STUDIO_BASE_URL = "http://lmstudio.test/v1";
  process.env.LLM_STUDIO_MODEL = "lms-model";
});
afterEach(() => vi.unstubAllGlobals());

describe("chat_template_kwargs", () => {
  it("MTPLX sends the reasoning level as a template kwarg AND top-level", async () => {
    const bodies = captureBody();
    await new MtplxProvider().completeChat([{ role: "user", content: "hi" }], {
      reasoningEffort: "low",
    });
    expect(bodies[0].chat_template_kwargs).toEqual({ reasoning_effort: "low" });
    expect(bodies[0].reasoning_effort).toBe("low");
  });

  it("LM Studio sends only the top-level field (its bridge is the model.yaml wrapper)", async () => {
    const bodies = captureBody();
    await new LlmStudioProvider().completeChat([{ role: "user", content: "hi" }], {
      reasoningEffort: "low",
    });
    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[0].reasoning_effort).toBe("low");
  });

  it("omits the field entirely when no effort is set", async () => {
    const bodies = captureBody();
    await new MtplxProvider().completeChat([{ role: "user", content: "hi" }]);
    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
  });

  it("MTPLX_TEMPLATE_KWARGS=false turns the transport off", async () => {
    process.env.MTPLX_TEMPLATE_KWARGS = "false";
    const bodies = captureBody();
    await new MtplxProvider().completeChat([{ role: "user", content: "hi" }], {
      reasoningEffort: "low",
    });
    delete process.env.MTPLX_TEMPLATE_KWARGS;
    expect(bodies[0]).not.toHaveProperty("chat_template_kwargs");
  });
});
