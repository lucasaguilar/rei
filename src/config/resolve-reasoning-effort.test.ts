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

  it("accepts the full OpenAI-compatible set (incl. minimal/xhigh)", () => {
    for (const v of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      process.env.REI_REASONING_EFFORT_ASK = v;
      expect(resolveReasoningEffort("ask")).toBe(v);
    }
  });

  it("rejects values the API doesn't accept (on/off/garbage)", () => {
    for (const v of ["on", "off", "ultra"]) {
      process.env.REI_REASONING_EFFORT_AGENT = v;
      expect(resolveReasoningEffort("agent")).toBeUndefined();
    }
  });

  it("returns undefined for an undefined mode", () => {
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
  });

  it("tolerates a trailing inline comment left by a naive .env loader", () => {
    // The bash wrapper used to export `none   # 27b binario...` verbatim, which failed the
    // set check → reasoning silently stayed ON. The value must still resolve to "none".
    process.env.REI_REASONING_EFFORT_AGENT =
      "none   # 27b binario: none=off (rápido). off NO es válido.";
    expect(resolveReasoningEffort("agent")).toBe("none");
  });
});
