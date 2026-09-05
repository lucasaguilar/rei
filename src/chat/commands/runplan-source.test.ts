import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runPlanCommand } from "./plan-commands.js";
import { saveCurrentPlanContent, savePlanToFile } from "../plan-tracker.js";
import { setActivePlan } from "../active-artifacts.js";
import type { CommandContext } from "./command-handler.js";
import type { ChatMessage } from "../types.js";

/**
 * /runplan picks its plan by heuristic — the newest session message containing a `## Stage N` line —
 * so a message that merely QUOTES the plan (a recap, a summary) can win over the plan itself. The
 * failure was silent: a stage "was not found" in a plan the user never meant to run, while the real
 * one sat saved on disk. Naming the source before executing turns that into something visible.
 */
let ws: string;
const PLAN = `# Plan: status bar

## Stage 1: Add the flag
Files to modify: src/a.ts
Verify: npx tsc --noEmit

## Stage 2: Render it
Files to modify: src/b.ts
Verify: npx tsc --noEmit
`;

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "rei-src-")); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

// No `provider` on purpose: these cover plan ROUTING, and without one /runplan keeps the
// single-session path instead of delegating each stage to a sub-agent.
const run = async (command: string, messages: ChatMessage[] = []) =>
  (await runPlanCommand.run({
    command,
    workspacePath: ws,
    session: { messages, mode: "planning" },
  } as unknown as CommandContext)) as { success: boolean; response: string };

const planMsg = (content: string): ChatMessage[] =>
  [{ role: "assistant", content, sourceMode: "planning" } as ChatMessage];

describe("precedence: the active plan owns the decision", () => {
  it("beats a session message that merely quotes another plan — the original bug", async () => {
    savePlanToFile(ws, "real", PLAN);
    setActivePlan(ws, "real");
    // A recap message that looks like a plan used to win purely by being newer.
    const recap = "Recap of what we did:\n\n## Stage 9: something else\n";
    const r = await run("/runplan stage 1", planMsg(recap));
    expect(r.success).toBe(true);
    expect(r.response).toContain('active plan "real"');
    expect(r.response).toContain("2 stages (1, 2)");
  });

  it("saving a plan makes it the one that runs", async () => {
    // /saveplan wires setActivePlan; this asserts the property that fix guarantees.
    savePlanToFile(ws, "saved", PLAN);
    setActivePlan(ws, "saved");
    const r = await run("/runplan stage 2", []);
    expect(r.success).toBe(true);
    expect(r.response).toContain('active plan "saved"');
  });

  it("falls back to the session when no plan is active, and says so", async () => {
    const r = await run("/runplan stage 1", planMsg(PLAN));
    expect(r.response).toContain("this session (no active plan set)");
  });

  it("warns when the active plan points at a file that is gone", async () => {
    setActivePlan(ws, "deleted");
    const r = await run("/runplan stage 1", planMsg(PLAN));
    expect(r.response).toMatch(/active plan "deleted" is set but .* is missing/);
  });

  it("picks up an edit to the active plan file — it holds a name, not a copy", async () => {
    savePlanToFile(ws, "live", PLAN);
    setActivePlan(ws, "live");
    savePlanToFile(ws, "live", PLAN + "\n## Stage 3: added later\nFiles to modify: src/c.ts\n");
    const r = await run("/runplan stage 3", []);
    expect(r.success).toBe(true);
    expect(r.response).toContain("3 stages (1, 2, 3)");
  });
});

describe("stage targets", () => {
  it("never targets REI's own artifacts — a plan that names its own path must not be edited", async () => {
    // A plan routinely records where it was saved. The file matcher accepts any known extension,
    // `.md` included, so that path became a "file to modify" and the execute directive told the
    // model to edit it — stage 2 rewrote the plan instead of the code.
    const plan =
      "# Plan\n\n## Stage 2: Render it\nFiles to modify: src/b.ts\n" +
      "Saved to .rei/plans/status-bar.md — see also .rei/specs/status-bar.md\n";
    const r = await run("/runplan stage 2", planMsg(plan)) as unknown as {
      autoExecute?: { prompt: string };
    };
    const files = r.autoExecute?.prompt.match(/FILES TO MODIFY:\n([^\n]*)/)?.[1] ?? "";
    expect(files).toBe("src/b.ts");
    expect(files).not.toContain("rei/plans");
    expect(files).not.toContain("rei/specs");
  });

  it("still passes ordinary markdown targets through", async () => {
    const plan = "# Plan\n\n## Stage 1: Document it\nFiles to modify: docs/guide.md\n";
    const r = await run("/runplan stage 1", planMsg(plan)) as unknown as {
      autoExecute?: { prompt: string };
    };
    expect(r.autoExecute?.prompt).toContain("docs/guide.md");
  });
});

describe("/runplan names its source", () => {
  it("reports the session as the source, with the stage numbers it found", async () => {
    const r = await run("/runplan stage 1", planMsg(PLAN));
    expect(r.response).toContain("Plan source: this session");
    expect(r.response).toContain("2 stages (1, 2)");
    expect(r.response).toContain("# Plan: status bar");
  });

  it("reports the persisted fallback when the session has no plan", async () => {
    saveCurrentPlanContent(ws, PLAN);
    const r = await run("/runplan stage 1", []);
    expect(r.response).toContain(".rei/current-plan-content.md");
    expect(r.response).toContain("no plan in this session");
  });

  it("shows the source on a missing stage, so the wrong plan is obvious", async () => {
    const r = await run("/runplan stage 7", planMsg(PLAN));
    expect(r.success).toBe(false);
    expect(r.response).toContain("Plan source:");
    expect(r.response).toContain("It has stages: 1, 2");
    expect(r.response).toContain("/loadplan");
  });

  it("explains the heading format when a bold-only plan is on screen but unparseable", async () => {
    // A model writing "**Stage 1**" instead of "## Stage 1" makes isPlanMessage reject the message,
    // so the user gets "No plan was found" while the plan is right there — the message must say why.
    const r = await run("/runplan stage 1", planMsg("# Plan\n\n**Stage 1: Add the flag**\n\nsome prose"));
    expect(r.success).toBe(false);
    expect(r.response).toContain("No plan was found");
    expect(r.response).toMatch(/## Stage 1/);
    expect(r.response).toMatch(/bold-only/i);
    expect(r.response).toContain("/loadplan");
  });

  it("prefers the newest session plan — the behaviour that surprises, now stated out loud", async () => {
    const recap = "Here is a recap:\n\n## Stage 9: something else\n";
    const r = await run("/runplan stage 1", [...planMsg(PLAN), ...planMsg(recap)]);
    expect(r.success).toBe(false);
    // It ran against the recap, not the real plan — and now says so.
    expect(r.response).toContain("It has stages: 9");
  });

  it("names the source when running the whole plan too", async () => {
    const r = await run("/runplan", planMsg(PLAN));
    expect(r.success).toBe(true);
    expect(r.response).toContain("Plan source: this session");
  });
});
