import { describe, it, expect, afterEach } from "vitest";
import { resolveAgentSampling } from "./model-runtime.js";

const KEYS = [
  "REI_AGENT_TEMPERATURE",
  "REI_AGENT_FREQUENCY_PENALTY",
  "REI_AGENT_PRESENCE_PENALTY",
] as const;

describe("resolveAgentSampling", () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to a mild temperature + penalties (NOT greedy)", () => {
    for (const k of KEYS) delete process.env[k];
    const s = resolveAgentSampling();
    expect(s.temperature).toBe(0.3);
    expect(s.frequencyPenalty).toBe(0.3);
    expect(s.presencePenalty).toBe(0.3);
    // the whole point: default is not greedy
    expect(s.temperature).toBeGreaterThan(0);
  });

  it("honors explicit overrides", () => {
    process.env.REI_AGENT_TEMPERATURE = "0.7";
    process.env.REI_AGENT_FREQUENCY_PENALTY = "0.5";
    process.env.REI_AGENT_PRESENCE_PENALTY = "0.1";
    const s = resolveAgentSampling();
    expect(s.temperature).toBe(0.7);
    expect(s.frequencyPenalty).toBe(0.5);
    expect(s.presencePenalty).toBe(0.1);
  });

  it("allows fully deterministic tool-calls via temperature 0 (cloud)", () => {
    process.env.REI_AGENT_TEMPERATURE = "0";
    expect(resolveAgentSampling().temperature).toBe(0);
  });

  it("clamps out-of-range values and ignores garbage", () => {
    process.env.REI_AGENT_TEMPERATURE = "5"; // > max 2
    process.env.REI_AGENT_FREQUENCY_PENALTY = "-1"; // < min 0
    process.env.REI_AGENT_PRESENCE_PENALTY = "abc"; // not a number → fallback
    const s = resolveAgentSampling();
    expect(s.temperature).toBe(2);
    expect(s.frequencyPenalty).toBe(0);
    expect(s.presencePenalty).toBe(0.3);
  });
});
