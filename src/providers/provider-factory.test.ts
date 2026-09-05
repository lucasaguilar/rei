import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveModelForMode } from "./provider-factory.js";

const MODEL_ENV_KEYS = [
  "MODEL_PROVIDER",
  "AGENT_MODEL_PROVIDER",
  "OLLAMA_MODEL",
  "OLLAMA_MODEL_AGENT",
  "OLLAMA_MODEL_ASK",
  "OLLAMA_MODEL_PLANNING",
  "LLM_STUDIO_MODEL",
  "LLM_STUDIO_MODEL_AGENT",
  "LLM_STUDIO_MODEL_ASK",
  "LLM_STUDIO_MODEL_PLANNING",
  "MTPLX_MODEL",
  "MTPLX_MODEL_AGENT",
  "OPENROUTER_MODEL",
  "OPENROUTER_MODEL_AGENT",
  "HF_MODEL",
  "HF_MODEL_AGENT",
];

describe("resolveModelForMode (uniform across providers)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of MODEL_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of MODEL_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("every mode falls back to <PROVIDER>_MODEL when it has no override", () => {
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    expect(resolveModelForMode("ask")).toBe("base-model");
    expect(resolveModelForMode("planning")).toBe("base-model");
    expect(resolveModelForMode("agent")).toBe("base-model");
  });

  it("gives each mode its own model when each override is set", () => {
    // The modes want different things: ask is interactive and favours a fast model, planning the
    // strongest reasoner, agent a reliable tool-caller.
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    process.env.LLM_STUDIO_MODEL_ASK = "ornith";
    process.env.LLM_STUDIO_MODEL_PLANNING = "qwen3.8";
    process.env.LLM_STUDIO_MODEL_AGENT = "musler";
    expect(resolveModelForMode("ask")).toBe("ornith");
    expect(resolveModelForMode("planning")).toBe("qwen3.8");
    expect(resolveModelForMode("agent")).toBe("musler");
  });

  it("lets one mode be overridden while the others keep the shared model", () => {
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    process.env.LLM_STUDIO_MODEL_PLANNING = "qwen3.8";
    expect(resolveModelForMode("ask")).toBe("base-model");
    expect(resolveModelForMode("planning")).toBe("qwen3.8");
    expect(resolveModelForMode("agent")).toBe("base-model");
  });

  it("treats an EMPTY per-mode override as unset, like the agent one", () => {
    // The wizard writes these for every mode; an empty value must not reach the backend as a
    // blank model name.
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    process.env.LLM_STUDIO_MODEL_ASK = "   ";
    expect(resolveModelForMode("ask")).toBe("base-model");
  });

  it("reads the per-mode override from the provider that mode actually uses", () => {
    // agent may run on its own provider; ask/planning always use MODEL_PROVIDER, so a planning
    // override must be read off the primary prefix, not the agent one.
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.AGENT_MODEL_PROVIDER = "ollama";
    process.env.LLM_STUDIO_MODEL_PLANNING = "qwen3.8";
    process.env.OLLAMA_MODEL_AGENT = "musler";
    expect(resolveModelForMode("planning")).toBe("qwen3.8");
    expect(resolveModelForMode("agent")).toBe("musler");
  });

  it("agent uses <PROVIDER>_MODEL_AGENT, falling back to <PROVIDER>_MODEL", () => {
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    expect(resolveModelForMode("agent")).toBe("base-model"); // fallback
    process.env.LLM_STUDIO_MODEL_AGENT = "agent-model";
    expect(resolveModelForMode("agent")).toBe("agent-model");
  });

  it("treats an EMPTY/whitespace agent var as unset and falls back to base", () => {
    // Regression: the config wizard writes LLM_STUDIO_MODEL_AGENT="" when no dedicated
    // agent model is chosen. "" must not be sent as the model name (LM Studio → 400
    // "No models loaded"); it must fall back to LLM_STUDIO_MODEL.
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    process.env.LLM_STUDIO_MODEL_AGENT = "";
    expect(resolveModelForMode("agent")).toBe("base-model");
    process.env.LLM_STUDIO_MODEL_AGENT = "   ";
    expect(resolveModelForMode("agent")).toBe("base-model");
  });

  it("treats Ollama like every other provider (ask/planning = OLLAMA_MODEL)", () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "ollama-base";
    process.env.OLLAMA_MODEL_AGENT = "ollama-agent";
    expect(resolveModelForMode("ask")).toBe("ollama-base");
    expect(resolveModelForMode("planning")).toBe("ollama-base");
    expect(resolveModelForMode("agent")).toBe("ollama-agent");
  });

  it("honours OLLAMA_MODEL_ASK / OLLAMA_MODEL_PLANNING again, now that every provider has them", () => {
    // These two were deprecated because Ollama was the ONLY provider with per-mode overrides, and
    // the inconsistency was the problem — not the capability. Every provider has them now, so they
    // are live again. An existing .env carrying them changes behaviour: previously dead, now read.
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "ollama-base";
    process.env.OLLAMA_MODEL_ASK = "ollama-ask";
    process.env.OLLAMA_MODEL_PLANNING = "ollama-planning";
    expect(resolveModelForMode("ask")).toBe("ollama-ask");
    expect(resolveModelForMode("planning")).toBe("ollama-planning");
  });

  it("agent mode can target a dedicated provider via AGENT_MODEL_PROVIDER", () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "ollama-base";
    process.env.AGENT_MODEL_PROVIDER = "openrouter";
    process.env.OPENROUTER_MODEL_AGENT = "or-agent";
    // ask/planning stay on the primary provider
    expect(resolveModelForMode("ask")).toBe("ollama-base");
    // agent jumps to the dedicated provider's _AGENT model
    expect(resolveModelForMode("agent")).toBe("or-agent");
  });

  it("uses the right env prefix for HF and LM Studio", () => {
    process.env.MODEL_PROVIDER = "huggingface";
    process.env.HF_MODEL = "hf-base";
    expect(resolveModelForMode("ask")).toBe("hf-base");
  });

  it("returns undefined for an unknown provider", () => {
    process.env.MODEL_PROVIDER = "mock";
    expect(resolveModelForMode("ask")).toBeUndefined();
  });

  it("resolves MTPLX models (mtplx provider)", () => {
    process.env.MODEL_PROVIDER = "mtplx";
    process.env.MTPLX_MODEL = "mis-modo-lo";
    expect(resolveModelForMode("ask")).toBe("mis-modo-lo");
    expect(resolveModelForMode("planning")).toBe("mis-modo-lo");
    expect(resolveModelForMode("agent")).toBe("mis-modo-lo"); // fallback
    process.env.MTPLX_MODEL_AGENT = "mtplx-agent";
    expect(resolveModelForMode("agent")).toBe("mtplx-agent");
  });

  it("treats empty MTPLX_MODEL_AGENT as unset and falls back to base", () => {
    process.env.MODEL_PROVIDER = "mtplx";
    process.env.MTPLX_MODEL = "mis-modo-lo";
    process.env.MTPLX_MODEL_AGENT = "";
    expect(resolveModelForMode("agent")).toBe("mis-modo-lo");
  });
});
