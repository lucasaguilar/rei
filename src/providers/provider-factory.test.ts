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

  it("ask and planning use <PROVIDER>_MODEL", () => {
    process.env.MODEL_PROVIDER = "llmstudio";
    process.env.LLM_STUDIO_MODEL = "base-model";
    expect(resolveModelForMode("ask")).toBe("base-model");
    expect(resolveModelForMode("planning")).toBe("base-model");
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

  it("ignores the deprecated OLLAMA_MODEL_ASK / OLLAMA_MODEL_PLANNING vars", () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "ollama-base";
    process.env.OLLAMA_MODEL_ASK = "should-be-ignored";
    process.env.OLLAMA_MODEL_PLANNING = "should-be-ignored";
    expect(resolveModelForMode("ask")).toBe("ollama-base");
    expect(resolveModelForMode("planning")).toBe("ollama-base");
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
