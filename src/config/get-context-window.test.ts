import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getContextWindow } from "./model-runtime.js";

const KEYS = [
  "REI_CONTEXT_WINDOW",
  "OLLAMA_NUM_CTX",
  "MODEL_PROVIDER",
  "AGENT_MODEL_PROVIDER",
  "OPENROUTER_CONTEXT_WINDOW",
  "GEMINI_CONTEXT_WINDOW",
  "GROQ_CONTEXT_WINDOW",
  "HF_CONTEXT_WINDOW",
];

describe("getContextWindow (per-provider auto-detection)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("explicit REI_CONTEXT_WINDOW always wins, any provider", () => {
    process.env.MODEL_PROVIDER = "openrouter";
    process.env.REI_CONTEXT_WINDOW = "61440";
    expect(getContextWindow()).toBe(61440);
  });

  it("local provider with no explicit value → 0 (no trimming)", () => {
    process.env.MODEL_PROVIDER = "lmstudio";
    expect(getContextWindow()).toBe(0);
    process.env.MODEL_PROVIDER = "ollama";
    expect(getContextWindow()).toBe(0);
  });

  it("cloud provider with no explicit value → large per-provider default", () => {
    process.env.MODEL_PROVIDER = "openrouter";
    expect(getContextWindow()).toBe(128000);
    process.env.MODEL_PROVIDER = "huggingface";
    expect(getContextWindow()).toBe(32000);
  });

  it("per-provider <PREFIX>_CONTEXT_WINDOW overrides the default", () => {
    process.env.MODEL_PROVIDER = "openrouter";
    process.env.OPENROUTER_CONTEXT_WINDOW = "200000";
    expect(getContextWindow()).toBe(200000);
  });

  it("uses the AGENT provider when set (drives the heavy turns)", () => {
    process.env.MODEL_PROVIDER = "lmstudio"; // local for ask/planning
    process.env.AGENT_MODEL_PROVIDER = "openrouter"; // cloud for agent
    expect(getContextWindow()).toBe(128000);
  });

  it("OLLAMA_NUM_CTX still works as an explicit fallback", () => {
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_NUM_CTX = "32000";
    expect(getContextWindow()).toBe(32000);
  });
});
