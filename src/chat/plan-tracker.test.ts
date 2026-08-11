import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveCurrentPlanContent,
  loadCurrentPlanContent,
  clearCurrentPlan,
  getTotalStagesInPlan,
  isPlanMessage,
  restoreCurrentPlanFromSession,
  savePlanToFile,
  loadPlanFromFile,
  saveReviewToFile,
  isReviewMessage,
} from "./plan-tracker.js";
import type { ChatMessage } from "./types.js";

const PLAN = `## Stage 1: Add field
Files to modify: a.ts

## Stage 2: Use field
Files to modify: a.html

## Stage 3: Style it
Files to modify: a.scss
`;

describe("loadPlanFromFile — input formats (@ / .md / path)", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-plan-load-"));
    savePlanToFile(ws, "my-plan", "PLAN CONTENT");
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("loads by bare name, with .md, with a path, and with an @ prefix", () => {
    for (const input of [
      "my-plan",
      "my-plan.md",
      ".rei/plans/my-plan.md",
      "@.rei/plans/my-plan.md", // the file-picker inserts @<path> — the bug that was failing
    ]) {
      expect(loadPlanFromFile(ws, input)).toBe("PLAN CONTENT");
    }
  });

  it("still throws a clear error for a missing plan", () => {
    expect(() => loadPlanFromFile(ws, "does-not-exist")).toThrow(/not found/);
    expect(() => loadPlanFromFile(ws, "@.rei/plans/nope.md")).toThrow(/not found/);
  });
});

describe("saveReviewToFile / isReviewMessage (/savereview)", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-review-"));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("saves the review next to the plan as <name>.review.md", () => {
    const p = saveReviewToFile(ws, "my-plan", "## Executive Summary\nNeeds critical fixes");
    expect(p.endsWith(".rei/plans/my-plan.review.md")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toContain("Needs critical fixes");
  });

  it("overwrites on re-save (re-audit reflects current plan)", () => {
    saveReviewToFile(ws, "p", "v1");
    const p = saveReviewToFile(ws, "p", "v2");
    expect(fs.readFileSync(p, "utf8")).toBe("v2");
  });

  it("isReviewMessage detects an auditor review, not a plan or chit-chat", () => {
    expect(isReviewMessage("## Executive Summary\n...")).toBe(true);
    expect(isReviewMessage("Approved with observations. Minor nits only.")).toBe(true);
    expect(isReviewMessage("Risks & Inconsistencies\n...\nBlind Spots & Key Questions")).toBe(true);
    expect(isReviewMessage("Sure, here is the code you asked for.")).toBe(false);
    expect(isReviewMessage("## Stage 1: do the thing")).toBe(false);
  });
});

describe("plan-tracker (no todo checklist)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rei-plan-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("round-trips the active plan content", () => {
    saveCurrentPlanContent(workspace, PLAN);
    expect(loadCurrentPlanContent(workspace)).toBe(PLAN);
  });

  it("never creates a current-plan-todo.md (the checklist was removed)", () => {
    saveCurrentPlanContent(workspace, PLAN);
    expect(fs.existsSync(path.join(workspace, ".rei", "current-plan-todo.md"))).toBe(
      false,
    );
  });

  it("counts the distinct stages in the active plan", () => {
    saveCurrentPlanContent(workspace, PLAN);
    expect(getTotalStagesInPlan(workspace)).toBe(3);
  });

  it("clears the active plan", () => {
    saveCurrentPlanContent(workspace, PLAN);
    clearCurrentPlan(workspace);
    expect(loadCurrentPlanContent(workspace)).toBeNull();
  });

  it("isPlanMessage detects stage headers", () => {
    expect(isPlanMessage(PLAN)).toBe(true);
    expect(isPlanMessage("just prose, no stages")).toBe(false);
  });

  it("restoreCurrentPlanFromSession picks the last planning-mode plan, ignoring agent messages", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: PLAN, sourceMode: "planning" },
      { role: "assistant", content: "## Stage 1: agent echo", sourceMode: "agent" },
    ];
    restoreCurrentPlanFromSession(workspace, messages);
    expect(loadCurrentPlanContent(workspace)).toBe(PLAN);
  });
});
