import { describe, it, expect, vi, beforeEach } from "vitest";

const { validateProposedPatches, buildFileContextMessage } = vi.hoisted(() => ({
  validateProposedPatches: vi.fn(),
  buildFileContextMessage: vi.fn(async () => "<file contents>"),
}));
const { findAdditionalCallerFiles } = vi.hoisted(() => ({
  findAdditionalCallerFiles: vi.fn(
    (): { callerFiles: string[]; changedSymbols: string[] } => ({
      callerFiles: [],
      changedSymbols: [],
    }),
  ),
}));
vi.mock("./patch-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./patch-helpers.js")>();
  return { ...actual, validateProposedPatches, buildFileContextMessage };
});
vi.mock("./contract-helper.js", () => ({ findAdditionalCallerFiles }));
vi.mock("../response-handler.js", () => ({ formatSREditsForLog: () => [] }));

import {
  handleSrEdits,
  createSrEditState,
  type SrEditState,
} from "./handle-sr-edits.js";
import type { ChatSession } from "../../chat/types.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const EDITS: AgentSREdit[] = [{ file: "a.ts", search: "x", replace: "y" }];

function run(over: {
  messages?: ChatSession["messages"];
  loopCount?: number;
  maxTurns?: number;
  state?: SrEditState;
  edits?: AgentSREdit[];
}) {
  const messages = over.messages ?? [];
  return {
    messages,
    promise: handleSrEdits({
      edits: over.edits ?? EDITS,
      rawResponse: "<edit>...</edit>",
      workspacePath: "/ws",
      scannedFiles: [],
      loopCount: over.loopCount ?? 1,
      maxTurns: over.maxTurns ?? 10,
      logger: fakeLogger,
      currentMessages: messages,
      firstTurnExplanation: "the plan",
      getFinalResponse: (r) => `FINAL:${r}`,
      state: over.state ?? createSrEditState(),
    }),
  };
}

describe("handleSrEdits", () => {
  beforeEach(() => {
    validateProposedPatches.mockReset();
    buildFileContextMessage.mockClear();
    findAdditionalCallerFiles.mockReset();
    findAdditionalCallerFiles.mockReturnValue({ callerFiles: [], changedSymbols: [] });
  });

  it("injects caller files for a contract change and continues (no validation yet)", async () => {
    findAdditionalCallerFiles.mockReturnValueOnce({
      callerFiles: ["caller.ts"],
      changedSymbols: ["foo"],
    });
    const state = createSrEditState();
    const { messages, promise } = run({ state });
    const outcome = await promise;
    expect(outcome.action).toBe("continue");
    expect(validateProposedPatches).not.toHaveBeenCalled();
    expect(state.autoInjectedCallerFiles.has("caller.ts")).toBe(true);
    expect(messages.at(-1)?.content).toContain("contracts");
  });

  it("finalizes as verified when validation succeeds", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: true });
    const outcome = await run({}).promise;
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.verified).toBe(true);
      expect(outcome.result.validProposedPatches).toEqual(EDITS);
    }
  });

  it("feeds back a generic retry and continues on a plain validation failure", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: false, feedback: "TS2304" });
    const { messages, promise } = run({});
    const outcome = await promise;
    expect(outcome.action).toBe("continue");
    expect(messages.at(-1)?.content).toContain("TS2304");
    expect(messages.at(-1)?.content).toContain("corrected <edit>");
  });

  it("escalates to rewrite_file after a file mismatches 2+ times", async () => {
    validateProposedPatches.mockResolvedValueOnce({
      success: false,
      feedback: "no match",
      mismatchOnly: true,
    });
    const state = createSrEditState();
    state.searchMismatchByFile.set("a.ts", 1); // already missed once → this makes it 2
    const { messages, promise } = run({ state });
    const outcome = await promise;
    expect(outcome.action).toBe("continue");
    expect(messages.at(-1)?.content).toContain("rewrite_file");
  });

  it("bails out (finalize) after the SAME error repeats 3 times", async () => {
    validateProposedPatches.mockResolvedValue({ success: false, feedback: "same err" });
    const state = createSrEditState();
    state.previousValidationError = "same err";
    state.consecutiveIdenticalErrors = 2; // this 3rd identical failure trips the guard
    const outcome = await run({ state }).promise;
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.failed).toBe(true);
      expect(outcome.result.response).toContain("Loop detected");
    }
  });

  it("finalizes as failed when validation fails on the last turn", async () => {
    validateProposedPatches.mockResolvedValueOnce({ success: false, feedback: "err" });
    const outcome = await run({ loopCount: 10, maxTurns: 10 }).promise;
    expect(outcome.action).toBe("finalize");
    if (outcome.action === "finalize") {
      expect(outcome.result.failed).toBe(true);
      expect(outcome.result.failedProposedPatches).toEqual(EDITS);
    }
  });
});
