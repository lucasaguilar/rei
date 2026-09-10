import { describe, it, expect, beforeEach, vi } from "vitest";

type Chunk = { type: "thinking" | "text" | "status"; content: string; kind?: "tool" | "notice" };

const executeAgentTurnWithTools = vi.hoisted(() =>
  vi.fn(async (_p: { onChunk?: (e: Chunk) => void }) => ({ response: "full turn text" })),
);
vi.mock("./generator-tools.js", () => ({ executeAgentTurnWithTools }));
vi.mock("./project-profile.js", () => ({ buildProjectProfile: () => "" }));

import { runSubAgent } from "./sub-agent-runner.js";

/** Runs a sub-agent whose worker emits `script`, and returns the summary handed back. */
const runWith = (script: Chunk[]) => {
  executeAgentTurnWithTools.mockImplementationOnce(async ({ onChunk }) => {
    for (const c of script) onChunk?.(c);
    return { response: "full turn text" };
  });
  return runSubAgent({
    task: "audit the plan",
    provider: {} as never,
    workspacePath: process.cwd(),
    logger: { logInfo: () => {} } as never,
  });
};

const text = (content: string): Chunk => ({ type: "text", content });
const tool = (content = "read_files"): Chunk => ({ type: "status", content, kind: "tool" });
const notice = (content = "hit the output limit"): Chunk =>
  ({ type: "status", content, kind: "notice" });

beforeEach(() => executeAgentTurnWithTools.mockReset());

/**
 * The worker's summary is the prose written after the LAST tool call — text before a tool ran was
 * narration about work still to come. That rule was applied to EVERY status, and the output-limit
 * continuation is a status too.
 *
 * So a report long enough to be cut in half lost its first half: the reader received a fragment
 * starting mid-document ("**Risks / follow-ups** — …") and no sign that anything was missing.
 */
describe("a sub-agent's report survives an output-limit continuation", () => {
  it("keeps the text written before the continuation notice", async () => {
    const summary = await runWith([
      text("## Findings\nThe plan omits error handling. "),
      notice(),
      text("**Risks / follow-ups** — performance overhead."),
    ]);
    expect(summary).toContain("## Findings");
    expect(summary).toContain("Risks / follow-ups");
  });

  it("joins the halves into one report rather than returning the tail", async () => {
    const summary = await runWith([text("first half. "), notice(), text("second half.")]);
    expect(summary).toBe("first half. second half.");
  });

  it("survives several continuations, which a long report will hit", async () => {
    const summary = await runWith([
      text("a"), notice(), text("b"), notice(), text("c"),
    ]);
    expect(summary).toBe("abc");
  });
});

describe("a tool status is still a boundary", () => {
  it("drops narration written before a tool ran", async () => {
    // "I'll start by reading the plan" is not the summary; the block after the last tool is.
    const summary = await runWith([
      text("I'll start by reading the plan."),
      tool(),
      text("The plan omits error handling."),
    ]);
    expect(summary).toBe("The plan omits error handling.");
  });

  it("keeps only the block after the LAST tool call", async () => {
    const summary = await runWith([
      text("narration one"), tool(), text("narration two"), tool(), text("the real summary"),
    ]);
    expect(summary).toBe("the real summary");
  });

  it("resets on an unmarked status, so an un-migrated emitter behaves as before", async () => {
    // `kind` is optional: anything not explicitly a notice keeps the old boundary semantics.
    const summary = await runWith([
      text("narration"), { type: "status", content: "ran a tool" }, text("summary"),
    ]);
    expect(summary).toBe("summary");
  });

  it("mixes both: narration, a tool, then a report cut in half", async () => {
    const summary = await runWith([
      text("let me read it"), tool(), text("## Findings "), notice(), text("and the rest."),
    ]);
    expect(summary).toBe("## Findings and the rest.");
  });
});
