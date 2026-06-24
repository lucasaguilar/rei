import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveReasoningEffort } from "./model-runtime.js";

const KEYS = [
  "REI_REASONING_EFFORT_ASK",
  "REI_REASONING_EFFORT_PLANNING",
  "REI_REASONING_EFFORT_AGENT",
];

describe("resolveReasoningEffort", () => {
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

  it("returns undefined when the per-mode var is unset", () => {
    expect(resolveReasoningEffort("ask")).toBeUndefined();
    expect(resolveReasoningEffort("agent")).toBeUndefined();
  });

  it("reads REI_REASONING_EFFORT_<MODE>", () => {
    process.env.REI_REASONING_EFFORT_ASK = "none";
    process.env.REI_REASONING_EFFORT_AGENT = "medium";
    expect(resolveReasoningEffort("ask")).toBe("none");
    expect(resolveReasoningEffort("agent")).toBe("medium");
  });

  it("normalizes case and trims whitespace", () => {
    process.env.REI_REASONING_EFFORT_PLANNING = "  HIGH  ";
    expect(resolveReasoningEffort("planning")).toBe("high");
  });

  it("ignores invalid values", () => {
    process.env.REI_REASONING_EFFORT_AGENT = "ultra";
    expect(resolveReasoningEffort("agent")).toBeUndefined();
  });

  it("returns undefined for an undefined mode", () => {
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
  });
});
