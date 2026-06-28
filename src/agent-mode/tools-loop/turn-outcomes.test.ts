import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the real finalizeOutcome (builds the ExecutionResult) but stub the heavy compile verify.
const { validateProposedPatches } = vi.hoisted(() => ({
  validateProposedPatches: vi.fn(),
}));
vi.mock("../helpers/patch-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../helpers/patch-helpers.js")>();
  return { ...actual, validateProposedPatches };
});

import {
  handleTruncation,
  buildTurnLimitOutcome,
  MAX_TRUNCATION_CONTINUATIONS,
  TRUNCATION_CONTINUATION,
} from "./turn-outcomes.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const noEdits = async (): Promise<AgentSREdit[]> => [];
const oneEdit = async (): Promise<AgentSREdit[]> => [
  { file: "a.ts", search: "x", replace: "y" },
];

describe("handleTruncation", () => {
  afterEach(() => vi.clearAllMocks());

  it("continues with a continuation nudge while budget remains, bumping the counter", async () => {
    const messages = [{ role: "user" as const, content: "go" }];
    const outcome = await handleTruncation({
      content: "partial output",
      reasoning: "thinking",
      currentMessages: messages,
      truncationContinuations: 0,
      logger: fakeLogger,
      emitStatus: () => {},
      virtualEdits: noEdits,
      firstTurnExplanation: "",
      appendCreatedSummary: (r) => r,
    });
    expect(outcome.action).toBe("continue");
    if (outcome.action === "continue") {
      expect(outcome.truncationContinuations).toBe(1);
      expect(outcome.messages.at(-1)?.content).toBe(TRUNCATION_CONTINUATION);
      // the partial assistant turn carries its reasoning forward
      const assistant = outcome.messages.at(-2);
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.reasoning_content).toBe("thinking");
    }
  });

  it("finalizes honestly once continuations are exhausted", async () => {
    const outcome = await handleTruncation({
      content: "partial",
      currentMessages: [],
      truncationContinuations: MAX_TRUNCATION_CONTINUATIONS,
      logger: fakeLogger,
      emitStatus: () => {},
      virtualEdits: noEdits,
      firstTurnExplanation: "",
      appendCreatedSummary: (r) => r,
    });
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.response).toContain("REI_MAX_OUTPUT_TOKENS");
    }
  });
});

describe("buildTurnLimitOutcome", () => {
  beforeEach(() => validateProposedPatches.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("applies queued edits with an honest final verify", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: true });
    const result = await buildTurnLimitOutcome({
      loopCount: 10,
      maxTurns: 10,
      workspacePath: "/ws",
      directMode: true,
      logger: fakeLogger,
      virtualEdits: oneEdit,
      firstTurnExplanation: "",
      appendCreatedSummary: (r) => r,
    });
    expect(result.verified).toBe(true);
    expect(result.response).toContain("turn limit");
  });

  it("reports a guided failure when nothing was queued", async () => {
    const result = await buildTurnLimitOutcome({
      loopCount: 10,
      maxTurns: 10,
      workspacePath: "/ws",
      directMode: true,
      logger: fakeLogger,
      virtualEdits: noEdits,
      firstTurnExplanation: "",
      appendCreatedSummary: (r) => r,
    });
    expect(result.failed).toBe(true);
    expect(validateProposedPatches).not.toHaveBeenCalled();
    expect(result.response).toContain("REI_MAX_TURNS=13");
  });
});
