import { describe, it, expect } from "vitest";
import { finalizeOutcome, type ExecutionResult } from "./patch-helpers.js";
import type { AgentLogger } from "../../core/logger.js";

// Minimal logger stub — finalizeOutcome only calls these three sinks.
const stubLogger = {
  logPatchOutcome() {},
  logPatchQuality() {},
  logInfo() {},
} as unknown as AgentLogger;

const edit = { file: "a.ts", search: "x", replace: "y" };

describe("finalizeOutcome: verified propagation", () => {
  it("propagates an explicit verified=false (final verify failed)", () => {
    const out: ExecutionResult = {
      response: "done",
      validProposedPatches: [edit],
      verified: false,
    };
    const result = finalizeOutcome(stubLogger, out, 1, 1);
    expect(result.verified).toBe(false);
  });

  it("propagates an explicit verified=true (final verify passed)", () => {
    const out: ExecutionResult = {
      response: "done",
      validProposedPatches: [edit],
      verified: true,
    };
    expect(finalizeOutcome(stubLogger, out, 1, 1).verified).toBe(true);
  });

  it("falls back to the legacy heuristic when verified is undefined", () => {
    // No explicit verify ran: not failed + has patches → verified true.
    const ok = finalizeOutcome(
      stubLogger,
      { response: "r", validProposedPatches: [edit] },
      1,
      1,
    );
    expect(ok.verified).toBe(true);

    // Failed turn with no patches → verified false.
    const bad = finalizeOutcome(
      stubLogger,
      { response: "r", validProposedPatches: [], failed: true },
      0,
      0,
    );
    expect(bad.verified).toBe(false);
  });
});
