import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the real finalizeOutcome (builds the ExecutionResult) but stub the heavy compile verify.
const { validateProposedPatches } = vi.hoisted(() => ({
  validateProposedPatches: vi.fn(),
}));
vi.mock("../helpers/patch-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("../helpers/patch-helpers.js")>();
  return { ...actual, validateProposedPatches };
});

import { handleTextResponse } from "./handle-text-response.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

function baseParams(over: Record<string, unknown> = {}) {
  return {
    content: "All done — I updated the config and verified it.",
    currentMessages: [{ role: "user" as const, content: "do it" }],
    loopCount: 1,
    maxTurns: 10,
    formatCorrections: 0,
    verifyRetries: 0,
    workspacePath: "/ws",
    directMode: true,
    logger: fakeLogger,
    emitStatus: () => {},
    provider: { completeChat: vi.fn(async () => "recap") } as never,
    modelOverride: undefined,
    firstTurnExplanation: "",
    virtualFiles: new Map<string, string>(),
    virtualEdits: async (): Promise<AgentSREdit[]> => [],
    createdFiles: [] as string[],
    appendCreatedSummary: (r: string) => r,
    ...over,
  };
}

describe("handleTextResponse", () => {
  beforeEach(() => validateProposedPatches.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("finalizes a genuine plain-text completion (no edits → no verify)", async () => {
    const outcome = await handleTextResponse(baseParams());
    expect(outcome.action).toBe("finalize");
    expect(validateProposedPatches).not.toHaveBeenCalled();
    if (outcome.action === "finalize") {
      expect(outcome.result.response).toContain("All done");
    }
  });

  it("nudges a faked-as-text tool call back to native and continues, bumping the counter", async () => {
    const outcome = await handleTextResponse(
      baseParams({ content: "<edit_file>foo</edit_file>" }),
    );
    expect(outcome.action).toBe("continue");
    if (outcome.action === "continue") {
      expect(outcome.formatCorrections).toBe(1);
      expect(outcome.messages.at(-1)?.content).toContain("native function-calling");
    }
  });

  it("stops nudging once format-corrections are exhausted (falls through to finalize)", async () => {
    const outcome = await handleTextResponse(
      baseParams({ content: "<edit_file>foo</edit_file>", formatCorrections: 2 }),
    );
    expect(outcome.action).toBe("finalize");
  });

  it("bounces failing final-verify back for self-correction and continues", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: false, verifyRan: true, feedback: "TS2304" });
    const outcome = await handleTextResponse(
      baseParams({ virtualEdits: async () => [{ file: "a.ts", search: "x", replace: "y" }] }),
    );
    expect(outcome.action).toBe("continue");
    if (outcome.action === "continue") {
      expect(outcome.verifyRetries).toBe(1);
      expect(outcome.messages.at(-1)?.content).toContain("TS2304");
    }
  });

  it("finalizes with verified=true when final-verify passes", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: true, verifyRan: true });
    const outcome = await handleTextResponse(
      baseParams({ virtualEdits: async () => [{ file: "a.ts", search: "x", replace: "y" }] }),
    );
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.verified).toBe(true);
    }
  });

  it("does NOT report verified when no check ran (a project REI has no command for)", async () => {
    // `success: true` with nothing executed used to finalize as verified=true. That is the exact
    // claim REI exists to refuse: a green has to come from a command that could have failed.
    validateProposedPatches.mockResolvedValueOnce({ success: true, verifyRan: false });
    const outcome = await handleTextResponse(
      baseParams({ virtualEdits: async () => [{ file: "a.ts", search: "x", replace: "y" }] }),
    );
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.verified).toBeUndefined();
    }
  });

  it("finalizes (not retry) when verify fails but no budget remains", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: false, verifyRan: true, feedback: "x" });
    const outcome = await handleTextResponse(
      baseParams({
        virtualEdits: async () => [{ file: "a.ts", search: "x", replace: "y" }],
        verifyRetries: 2,
      }),
    );
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.verified).toBe(false);
    }
  });
});
