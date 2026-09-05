import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The worker's summary is the ONLY thing that survives its isolated context: it goes back to the
 * orchestrator and, in a delegated plan, becomes the next stage's entire view of this one. So it
 * must be the summary and nothing else — narration written before a tool call compounds down a
 * plan, which is exactly the context growth delegation exists to prevent.
 */
const turn = vi.fn();
vi.mock("./generator-tools.js", () => ({
  executeAgentTurnWithTools: (...args: unknown[]) => turn(...args),
}));
vi.mock("./project-profile.js", () => ({ buildProjectProfile: () => "" }));

import { runSubAgent } from "./sub-agent-runner.js";

/** Replays a scripted chunk stream through the runner and returns the summary it kept. */
async function summaryFrom(chunks: Array<{ type: string; content: string }>, response: string) {
  turn.mockImplementationOnce(async (params: { onChunk?: (e: unknown) => void }) => {
    for (const c of chunks) params.onChunk?.(c);
    return { response };
  });
  return runSubAgent({
    task: "t",
    provider: {} as never,
    workspacePath: "/tmp",
    logger: { logInfo: () => {} } as never,
  });
}

beforeEach(() => turn.mockReset());

describe("the sub-agent's returned summary", () => {
  it("drops the narration written before a tool call", async () => {
    const summary = await summaryFrom(
      [
        { type: "text", content: "I'll start by reading the current state of cart.ts." },
        { type: "status", content: "Reading: cart.ts" },
        { type: "text", content: "Stage 2 complete: added vitest and cart.test.ts." },
      ],
      "I'll start by reading the current state of cart.ts.\nStage 2 complete: added vitest and cart.test.ts.",
    );

    expect(summary).toBe("Stage 2 complete: added vitest and cart.test.ts.");
    expect(summary).not.toContain("I'll start by");
  });

  it("keeps only the block after the LAST tool call, across several", async () => {
    const summary = await summaryFrom(
      [
        { type: "text", content: "first I read" },
        { type: "status", content: "Reading" },
        { type: "text", content: "now I edit" },
        { type: "status", content: "Editing" },
        { type: "text", content: "Done: added subtract()." },
      ],
      "everything concatenated",
    );
    expect(summary).toBe("Done: added subtract().");
  });

  it("drops REI's own \"N file(s) created\" footer, appended after streaming", async () => {
    const summary = await summaryFrom(
      [
        { type: "status", content: "Creating: cart.test.ts" },
        { type: "text", content: "Stage 2 complete: created the test file." },
      ],
      "Stage 2 complete: created the test file.\n\n---\n[32m[1m1 file(s) created:[0m\n- cart.test.ts",
    );
    expect(summary).toBe("Stage 2 complete: created the test file.");
    expect(summary).not.toContain("file(s) created");
  });

  it("ignores thinking entirely", async () => {
    const summary = await summaryFrom(
      [
        { type: "thinking", content: "Let me consider the options…" },
        { type: "text", content: "Done." },
      ],
      "Done.",
    );
    expect(summary).toBe("Done.");
  });

  it("falls back to the full response when nothing streamed", async () => {
    // A non-streaming provider emits no text chunks; an empty tail there means "no stream", not
    // "no summary", so dropping the response would lose the worker's only output.
    expect(await summaryFrom([], "The whole answer.")).toBe("The whole answer.");
  });

  it("says so when the worker produced nothing at all", async () => {
    expect(await summaryFrom([], "")).toContain("no summary");
  });
});
