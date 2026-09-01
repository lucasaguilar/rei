import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runPlanCommand } from "./plan-commands.js";
import { saveCurrentPlanContent } from "../plan-tracker.js";
import type { CommandContext } from "./command-handler.js";

/**
 * A spec-driven plan closes with a stage whose product is a REPORT, not edits. The execute directive
 * that makes /runplan act instead of narrate forbids "a prose description" and demands edit_file
 * calls — head-on opposite of what that stage must do. Without the split, the closing verification
 * would be pushed into editing files and its report suppressed.
 */
let ws: string;
const PLAN = `# Plan

## Stage 1: Add the setting
Files to modify: src/config/thing.ts
Change: Add the flag.
Verify: npx tsc --noEmit
Depends on: none

## Stage 2: Write one test per acceptance criterion
Files to modify: src/config/thing.test.ts
Change: One test per criterion.
Skill: write-tests
Verify: npx vitest run
Depends on: 1

## Stage 3: Verify the implementation against the spec
Files to modify: (none — this stage reports, it does not edit)
Change: Judge every acceptance criterion MET / NOT MET / UNVERIFIED with evidence.
Skill: verify-against-spec
Verify: (none — the output IS the verification)
Depends on: 2
`;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-runplan-"));
  saveCurrentPlanContent(ws, PLAN);
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const run = async (command: string) =>
  runPlanCommand.run({
    command,
    workspacePath: ws,
    session: { messages: [], mode: "planning" },
  } as unknown as CommandContext);

describe("/runplan on a report-only stage", () => {
  it("tells the verification stage to REPORT, not edit", async () => {
    const r = await run("/runplan stage 3");
    const prompt = (r as { autoExecute?: { prompt: string } }).autoExecute?.prompt ?? "";
    expect(prompt).toContain("REPORT NOW");
    expect(prompt).toMatch(/NOT call edit_file/);
    expect(prompt).not.toContain("EXECUTE NOW");
  });

  it("still tells an implementation stage to EXECUTE", async () => {
    const r = await run("/runplan stage 1");
    const prompt = (r as { autoExecute?: { prompt: string } }).autoExecute?.prompt ?? "";
    expect(prompt).toContain("EXECUTE NOW");
    expect(prompt).not.toContain("REPORT NOW");
  });

  it("a test-writing stage still executes — it edits a file", async () => {
    const r = await run("/runplan stage 2");
    const prompt = (r as { autoExecute?: { prompt: string } }).autoExecute?.prompt ?? "";
    expect(prompt).toContain("EXECUTE NOW");
  });

  it("does not forbid edits merely because a stage lists no files", async () => {
    saveCurrentPlanContent(
      ws,
      "# Plan\n\n## Stage 1: Install deps\nFiles to modify: (none)\nChange: run npm install\nVerify: npm ls\nDepends on: none\n",
    );
    const r = await run("/runplan stage 1");
    const prompt = (r as { autoExecute?: { prompt: string } }).autoExecute?.prompt ?? "";
    expect(prompt).toContain("EXECUTE NOW");
  });
});
