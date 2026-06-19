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
} from "./plan-tracker.js";
import type { ChatMessage } from "./types.js";

const PLAN = `## Stage 1: Add field
Files to modify: a.ts

## Stage 2: Use field
Files to modify: a.html

## Stage 3: Style it
Files to modify: a.scss
`;

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
