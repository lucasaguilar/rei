import { describe, it, expect, vi } from "vitest";
import {
  splitPlanIntoStages,
  delegableStages,
  buildStageTask,
  runStagesViaSubAgents,
  formatDelegationReport,
} from "./plan-delegation.js";

const PLAN = `# Plan: login

## Stage 1: Add the form component
Files to modify: src/login.ts
Change: Render the form.
Satisfies: AC-1
Verify: tsc --noEmit

## Stage 2: Reject bad passwords
Files to modify: src/auth.ts, src/errors.ts
Change: Return an error.
Depends on: 1
Verify: tsc --noEmit

## Stage 3: Verify the implementation against the spec
Change: Judge every acceptance criterion.
Skill: verify-against-spec
`;

describe("splitPlanIntoStages", () => {
  it("carves each stage out with its own body and files", () => {
    const stages = splitPlanIntoStages(PLAN);
    expect(stages.map((s) => s.num)).toEqual([1, 2, 3]);
    expect(stages[0].title).toBe("Add the form component");
    expect(stages[0].files).toEqual(["src/login.ts"]);
    expect(stages[1].files).toEqual(["src/auth.ts", "src/errors.ts"]);
    // A stage's body must not bleed into the next one.
    expect(stages[0].body).not.toContain("Reject bad passwords");
  });

  it("marks the report stage and reads Depends on", () => {
    const stages = splitPlanIntoStages(PLAN);
    expect(stages.map((s) => s.isReport)).toEqual([false, false, true]);
    expect(stages[1].dependsOn).toEqual([1]);
  });

  it("never treats REI's own artifacts as files to modify", () => {
    // A plan routinely states where it was saved; that path is not a target.
    const plan = "## Stage 1: x\nFiles to modify: .rei/plans/login.md, src/real.ts\n";
    expect(splitPlanIntoStages(plan)[0].files).toEqual(["src/real.ts"]);
  });

  it("returns nothing when no heading parses as a stage", () => {
    expect(splitPlanIntoStages("# Plan\n\n**Stage 1** bold only\n")).toEqual([]);
  });
});

describe("delegableStages", () => {
  it("stops at the first report stage", () => {
    expect(delegableStages(splitPlanIntoStages(PLAN)).map((s) => s.num)).toEqual([1, 2]);
  });

  it("delegates everything when the plan has no report stage", () => {
    const plan = PLAN.replace(/## Stage 3[\s\S]*$/, "");
    expect(delegableStages(splitPlanIntoStages(plan)).map((s) => s.num)).toEqual([1, 2]);
  });
});

describe("buildStageTask", () => {
  it("carries forward what the stages it depends on did", () => {
    // The worker starts fresh, so a decision made in stage 1 is invisible unless passed in.
    const [, stage2] = splitPlanIntoStages(PLAN);
    const task = buildStageTask(stage2, new Map([[1, "Added LoginForm in src/login.ts."]]));
    expect(task).toContain("Added LoginForm in src/login.ts.");
    expect(task).toContain("Stage 2");
  });

  it("omits the dependency block when there is nothing to carry", () => {
    const [stage1] = splitPlanIntoStages(PLAN);
    expect(buildStageTask(stage1, new Map())).not.toContain("depends on");
  });

  it("does not invent a summary for a dependency that has none", () => {
    const [, stage2] = splitPlanIntoStages(PLAN);
    expect(buildStageTask(stage2, new Map())).not.toContain("Stage 1:");
  });
});

describe("runStagesViaSubAgents", () => {
  it("runs stages in order and threads each summary into the next", async () => {
    const seen: string[] = [];
    const runner = vi.fn(async (task: string) => {
      seen.push(task);
      return `did stage ${seen.length}`;
    });
    const outcomes = await runStagesViaSubAgents(delegableStages(splitPlanIntoStages(PLAN)), runner);

    expect(outcomes.map((o) => o.stage)).toEqual([1, 2]);
    expect(outcomes.every((o) => !o.failed)).toBe(true);
    expect(seen[1]).toContain("did stage 1"); // stage 2 received stage 1's summary
  });

  it("stops at the first failure instead of building on a broken base", async () => {
    const runner = vi.fn(async (task: string) => {
      if (task.includes("Stage 2")) throw new Error("tsc failed");
      return "ok";
    });
    const outcomes = await runStagesViaSubAgents(delegableStages(splitPlanIntoStages(PLAN)), runner);

    expect(outcomes.map((o) => o.failed)).toEqual([false, true]);
    expect(runner).toHaveBeenCalledTimes(2); // never reached a third
    expect(outcomes[1].summary).toContain("tsc failed");
  });

  it("passes each stage's own files to the runner", async () => {
    const files: string[][] = [];
    await runStagesViaSubAgents(delegableStages(splitPlanIntoStages(PLAN)), async (_t, f) => {
      files.push(f);
      return "ok";
    });
    expect(files).toEqual([["src/login.ts"], ["src/auth.ts", "src/errors.ts"]]);
  });
});

describe("formatDelegationReport", () => {
  it("says where a failed run stopped", () => {
    const out = formatDelegationReport(
      [
        { stage: 1, title: "a", summary: "ok", failed: false },
        { stage: 2, title: "b", summary: "tsc failed", failed: true },
      ],
      2,
    );
    expect(out).toContain("Stopped at stage 2 of 2");
    expect(out).toContain("✖ Stage 2");
  });

  it("announces the report stage that was deliberately not delegated", () => {
    const out = formatDelegationReport([{ stage: 1, title: "a", summary: "ok", failed: false }], 1, 3);
    expect(out).toContain("Stage 3 produces a report and is NOT delegated");
  });

  it("does not announce a pending report stage after a failure", () => {
    const out = formatDelegationReport(
      [{ stage: 1, title: "a", summary: "boom", failed: true }],
      1,
      undefined,
    );
    expect(out).not.toContain("NOT delegated");
  });
});
