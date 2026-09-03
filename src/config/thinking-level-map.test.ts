import { describe, it, expect, afterEach } from "vitest";
import {
  mapThinkingLevel,
  resolveReasoningEffort,
  setThinkingOverride,
} from "./model-runtime.js";
import { setActiveModelTuning } from "./model-tuning.js";

/**
 * REI's whitelist is the OpenAI-standard set, but a model's real range is narrower. Qwen3.8's chat
 * template only knows low/medium/xhigh; asking for `high` is silently dropped (LM Studio falls back
 * to the field's default) so the request succeeds and nothing changed. The map turns that invisible
 * miss into either a declared translation or a refusal.
 */
const QWEN38: Record<string, string | null> = {
  none: null,
  minimal: null,
  high: null,
  low: "low",
  medium: "medium",
  xhigh: "xhigh",
};

afterEach(() => {
  setThinkingOverride(undefined);
  setActiveModelTuning(undefined);
  delete process.env.REI_REASONING_EFFORT_AGENT;
});

describe("mapThinkingLevel", () => {
  it("passes a level through when the model declares no map", () => {
    expect(mapThinkingLevel("high", undefined)).toBe("high");
  });

  it("passes through a level the map does not list — the map is additive", () => {
    expect(mapThinkingLevel("medium", { high: null })).toBe("medium");
  });

  it("drops a level the model declares unsupported", () => {
    expect(mapThinkingLevel("high", QWEN38)).toBeUndefined();
    expect(mapThinkingLevel("none", QWEN38)).toBeUndefined();
  });

  it("keeps a supported level as itself", () => {
    expect(mapThinkingLevel("xhigh", QWEN38)).toBe("xhigh");
  });

  it("applies a translation the user declared", () => {
    expect(mapThinkingLevel("high", { high: "xhigh" })).toBe("xhigh");
  });
});

describe("precedence: /think > per-model > env > thinking:off", () => {
  it("the model's reasoningEffort beats the per-mode env — the tuning convention", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "low";
    setActiveModelTuning({ id: "m", reasoningEffort: "xhigh" });
    expect(resolveReasoningEffort("agent")).toBe("xhigh");
  });

  it("/think still beats the model's own default", () => {
    setActiveModelTuning({ id: "m", reasoningEffort: "xhigh" });
    setThinkingOverride("low");
    expect(resolveReasoningEffort("agent")).toBe("low");
  });

  it("falls through to the env when the model declares none", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "medium";
    setActiveModelTuning({ id: "m" });
    expect(resolveReasoningEffort("agent")).toBe("medium");
  });

  it("ignores a per-model value that is not a real level", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "medium";
    setActiveModelTuning({ id: "m", reasoningEffort: "turbo" });
    expect(resolveReasoningEffort("agent")).toBe("medium");
  });

  it("still honours thinking:'off' when nothing else is set", () => {
    setActiveModelTuning({ id: "m", thinking: "off" });
    expect(resolveReasoningEffort("agent")).toBe("none");
  });

  it("a per-model level is translated by the model's own map", () => {
    setActiveModelTuning({ id: "m", reasoningEffort: "high", thinkingLevelMap: { high: "xhigh" } });
    expect(resolveReasoningEffort("agent")).toBe("xhigh");
  });

  it("drops a per-model level the same model declares unsupported — a config that contradicts itself", () => {
    setActiveModelTuning({ id: "m", reasoningEffort: "high", thinkingLevelMap: QWEN38 });
    expect(resolveReasoningEffort("agent")).toBeUndefined();
  });
});

describe("resolveReasoningEffort with a map", () => {
  it("translates the /think override, so switching models switches the translation", () => {
    setActiveModelTuning({ id: "m", thinkingLevelMap: { high: "xhigh" } });
    setThinkingOverride("high");
    expect(resolveReasoningEffort("agent")).toBe("xhigh");

    setActiveModelTuning({ id: "other" }); // no map
    expect(resolveReasoningEffort("agent")).toBe("high");
  });

  it("sends nothing when the override is unsupported, instead of a value that gets dropped", () => {
    setActiveModelTuning({ id: "m", thinkingLevelMap: QWEN38 });
    setThinkingOverride("high");
    expect(resolveReasoningEffort("agent")).toBeUndefined();
  });

  it("translates the env value too — the same path, not a special case", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "high";
    setActiveModelTuning({ id: "m", thinkingLevelMap: { high: "xhigh" } });
    expect(resolveReasoningEffort("agent")).toBe("xhigh");
  });

  it("drops an env value the model does not support", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "none";
    setActiveModelTuning({ id: "m", thinkingLevelMap: QWEN38 });
    expect(resolveReasoningEffort("agent")).toBeUndefined();
  });

  it("changes nothing for a model without a map — existing configs keep working", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "medium";
    setActiveModelTuning({ id: "m" });
    expect(resolveReasoningEffort("agent")).toBe("medium");
  });
});
