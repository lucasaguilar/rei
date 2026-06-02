/**
 * Tests for the <call_tool> chaining branch inside executeAgentTurn.
 *
 * The key behaviour under test: when the model emits a <call_tool> tag,
 * - MCP tools (mcp: prefix / in modelFeedbackTools) → result is pushed back as
 *   a user message and the model is called again (chaining).
 * - Fire-and-forget tools (weather, search) → result appended to response, no
 *   second model call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (must be hoisted) ────────────────────────────────────

vi.mock("../core/helpers/action-executor.js", () => ({
  executeToolCallsFromResponse: vi.fn().mockResolvedValue("\n### 🔌 MCP: fs/read\nfile content\n"),
}));

vi.mock("./helpers/patch-helpers.js", () => ({
  buildFileContextMessage: vi.fn().mockResolvedValue(""),
  validateProposedPatches: vi.fn().mockResolvedValue({ success: false, feedback: "no match" }),
  handleCreateFileBlocks: vi.fn().mockResolvedValue({ feedback: null, created: [] }),
  stripAllActionTags: vi.fn((s: string) => s),
  generateXmlToolCallId: vi.fn((name: string) => `xml_${name}_test`),
  finalizeOutcome: vi.fn((logger: unknown, result: { response: string; validProposedPatches: unknown[]; failed?: boolean }, proposed: number, applied: number) => ({
    response: result.response,
    validProposedPatches: result.validProposedPatches,
    failed: result.failed ?? false,
    proposedCount: proposed,
    appliedCount: applied,
  })),
}));

vi.mock("../tools/command-executor.js", () => ({
  executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  limitCommandOutput: vi.fn((s: string) => s),
}));

vi.mock("./helpers/contract-helper.js", () => ({
  findAdditionalCallerFiles: vi.fn().mockReturnValue({ callerFiles: [], changedSymbols: [] }),
}));

vi.mock("./helpers/loop-guard.js", () => ({
  isDegenerate: vi.fn().mockReturnValue(false),
  buildCommandSignature: vi.fn().mockReturnValue(""),
}));

vi.mock("../tools/patch-applier.js", () => ({
  applyWholeFileBatchFS: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { executeAgentTurn } from "./generator.js";
import { executeToolCallsFromResponse } from "../core/helpers/action-executor.js";
import type { ModelProvider } from "../providers/model-provider.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const fakeLogger = {
  logInfo: vi.fn(),
  logCommandExecution: vi.fn(),
  logSREditsParsed: vi.fn(),
  logNoEditsReason: vi.fn(),
  startTurn: vi.fn(),
  setCorrelationId: vi.fn(),
} as never;

function makeProvider(responses: string[]): ModelProvider {
  let call = 0;
  return {
    // streamChat must return an async iterable of string tokens.
    streamChat: vi.fn((_messages: unknown, opts: { onFinish?: (r: string) => void }) => {
      const text = responses[call++] ?? "";
      opts?.onFinish?.("stop");
      return (async function* () { yield text; })();
    }),
    completeChat: vi.fn(),
  } as unknown as ModelProvider;
}

function makeMcpRegistry(dispatch = vi.fn().mockResolvedValue("file content")) {
  return { dispatch } as never;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("executeAgentTurn — <call_tool> chaining", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-feeds the model when an MCP call (mcp: prefix) is in modelFeedbackTools", async () => {
    const mcpCallResponse = `<call_tool name="mcp:fs/readFile">{"path":"a.ts"}</call_tool>`;
    const finalResponse = "Here is my answer.";

    const provider = makeProvider([mcpCallResponse, finalResponse]);
    const feedbackTools = new Set(["mcp:fs/readFile"]);

    const outcome = await executeAgentTurn({
      provider,
      messagesForModel: [{ role: "user", content: "do something" }],
      workspacePath: "/workspace",
      scannedFiles: [],
      logger: fakeLogger,
      mcpRegistry: makeMcpRegistry(),
      modelFeedbackTools: feedbackTools,
    });

    // executeToolCallsFromResponse was called to dispatch the MCP tool
    expect(executeToolCallsFromResponse).toHaveBeenCalledOnce();
    // The final outcome came from the second model call (the answer turn)
    expect(outcome.response).toContain(finalResponse);
    // Provider was called twice: once for MCP call, once for the follow-up
    expect(provider.streamChat).toHaveBeenCalledTimes(2);
  });

  it("does NOT re-feed the model for a fire-and-forget tool not in modelFeedbackTools", async () => {
    const weatherCallResponse = `<call_tool name="weather">London</call_tool>`;

    // Only one model response — if it called the model again it would get undefined
    const provider = makeProvider([weatherCallResponse]);
    const feedbackTools = new Set<string>(); // weather is NOT in the set

    vi.mocked(executeToolCallsFromResponse).mockResolvedValueOnce("\n### 🌤️ Weather: London\nSunny\n");

    const outcome = await executeAgentTurn({
      provider,
      messagesForModel: [{ role: "user", content: "weather?" }],
      workspacePath: "/workspace",
      scannedFiles: [],
      logger: fakeLogger,
      mcpRegistry: makeMcpRegistry(),
      modelFeedbackTools: feedbackTools,
    });

    // Provider called only once — no re-feed
    expect(provider.streamChat).toHaveBeenCalledTimes(1);
    // Weather result is appended to the response (shown to user)
    expect(outcome.response).toContain("Weather: London");
  });
});
