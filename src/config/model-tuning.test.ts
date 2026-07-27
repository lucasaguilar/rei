import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  matchModel,
  resolveModelTuning,
  setActiveModelTuning,
  type ModelTuning,
} from "./model-tuning.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  resolveAgentSampling,
  resolveReasoningEffort,
} from "./model-runtime.js";

const models: ModelTuning[] = [
  { id: "deepreinforce-ai/ornith-1.0-35b", temperature: 0.35, contextWindow: 65536 },
  { id: "qwen/qwen3.6-35b-a3b", temperature: 0.6, presencePenalty: 0, thinking: "off" },
];

describe("matchModel (name normalization)", () => {
  it("matches on the full HF id (prefix stripped, case-insensitive)", () => {
    expect(matchModel("mlx-community/Ornith-1.0-35B", models)?.id).toContain("ornith");
  });
  it("matches a -thinking variant to its base id", () => {
    expect(matchModel("qwen/qwen3.6-35b-a3b-thinking", models)?.id).toContain("qwen3.6-35b-a3b");
  });
  it("returns undefined for an unknown model", () => {
    expect(matchModel("meta/llama-3-8b", models)).toBeUndefined();
  });
});

describe("matchModel (no prefix match — collision safety)", () => {
  it("short config id 'qwen' does NOT match 'qwen3.6-27b'", () => {
    const shortId = [{ id: "qwen", temperature: 0.5 }];
    expect(matchModel("qwen3.6-27b", shortId)).toBeUndefined();
  });

  it("short config id 'gemma' does NOT match 'gemma-4-26b-a4b'", () => {
    const shortId = [{ id: "gemma", temperature: 0.4 }];
    expect(matchModel("gemma-4-26b-a4b", shortId)).toBeUndefined();
  });

  it("normalization still works: provider prefix stripped, exact match after", () => {
    const withProvider = [{ id: "ornith-1.0-35b", temperature: 0.35 }];
    expect(matchModel("mlx-community/Ornith-1.0-35B", withProvider)?.temperature).toBe(0.35);
  });

  it("matches exact full ID first, allowing distinct tunings for different org prefixes", () => {
    const multiOrg: ModelTuning[] = [
      { id: "mlx-community/ornith-1.0-35b", temperature: 0.35 },
      { id: "deepreinforce-ai/ornith-1.0-35b", temperature: 0.15 },
    ];
    expect(matchModel("mlx-community/ornith-1.0-35b", multiOrg)?.temperature).toBe(0.35);
    expect(matchModel("deepreinforce-ai/ornith-1.0-35b", multiOrg)?.temperature).toBe(0.15);
  });
});

describe("resolveModelTuning (reads rei.config.json)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rei-tuning-"));
    fs.writeFileSync(
      path.join(dir, "rei.config.json"),
      JSON.stringify({ providers: { lmstudio: { models } } }),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("finds the tuning for the active model", () => {
    const t = resolveModelTuning("mlx-community/ornith-1.0-35b", dir);
    expect(t?.temperature).toBe(0.35);
    expect(t?.contextWindow).toBe(65536);
  });
  it("returns undefined when the model isn't configured", () => {
    expect(resolveModelTuning("unknown/model", dir)).toBeUndefined();
  });
});

describe("config resolvers honor the active tuning (precedence over env defaults)", () => {
  beforeEach(() => {
    // Clear env vars that may be set by .env so tests are deterministic.
    delete process.env.REI_AGENT_TEMPERATURE;
    delete process.env.REI_AGENT_FREQUENCY_PENALTY;
    delete process.env.REI_REASONING_EFFORT_AGENT;
  });
  afterEach(() => {
    setActiveModelTuning(undefined);
    delete process.env.REI_AGENT_TEMPERATURE;
    delete process.env.REI_AGENT_FREQUENCY_PENALTY;
    delete process.env.REI_REASONING_EFFORT_AGENT;
  });

  it("getContextWindow / getMaxOutputTokens use the per-model values", () => {
    setActiveModelTuning({ id: "x", contextWindow: 40000, maxTokens: 4096 });
    expect(getContextWindow()).toBe(40000);
    expect(getMaxOutputTokens()).toBe(4096);
  });

  it("resolveAgentSampling uses the per-model temperature over the env default", () => {
    process.env.REI_AGENT_TEMPERATURE = "0.3";
    setActiveModelTuning({ id: "x", temperature: 0.6, presencePenalty: 0 });
    const s = resolveAgentSampling();
    expect(s.temperature).toBe(0.6); // config wins over env
    expect(s.presencePenalty).toBe(0);
    expect(s.frequencyPenalty).toBe(0.3); // not in config → env default
  });

  it("resolveAgentSampling surfaces topP/topK from the tuning (undefined when not set)", () => {
    setActiveModelTuning({ id: "x", topP: 0.8, topK: 20 });
    expect(resolveAgentSampling()).toMatchObject({ topP: 0.8, topK: 20 });
    setActiveModelTuning({ id: "y" });
    const s = resolveAgentSampling();
    expect(s.topP).toBeUndefined();
    expect(s.topK).toBeUndefined();
  });

  it("thinking:'off' maps to reasoning_effort none (when env is unset)", () => {
    setActiveModelTuning({ id: "x", thinking: "off" });
    expect(resolveReasoningEffort("agent")).toBe("none");
  });
});
