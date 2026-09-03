import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getActive,
  setActiveSpec,
  setActivePlan,
  readActivePlan,
  activePlanPath,
} from "./active-artifacts.js";

/**
 * The pointer replaces a four-way split in which the least reliable source won: a session message
 * that merely QUOTED a plan outranked the plan saved on disk, so saving a plan did not make it the
 * one that ran. It stores NAMES, never copies, so nothing can go stale against the file it names.
 */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-active-"));
  mkdirSync(join(ws, ".rei", "plans"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("active pointer", () => {
  it("starts empty", () => {
    expect(getActive(ws)).toEqual({});
  });

  it("records spec and plan independently", () => {
    setActiveSpec(ws, "status-bar");
    setActivePlan(ws, "status-bar");
    expect(getActive(ws)).toEqual({ spec: "status-bar", plan: "status-bar" });
  });

  it("setting one does not clear the other", () => {
    setActiveSpec(ws, "alpha");
    setActivePlan(ws, "beta");
    setActiveSpec(ws, "gamma");
    expect(getActive(ws)).toEqual({ spec: "gamma", plan: "beta" });
  });

  it("survives a restart — it is on disk, not in the session", () => {
    setActivePlan(ws, "status-bar");
    // A fresh read with no in-memory state at all.
    expect(getActive(ws).plan).toBe("status-bar");
    expect(readFileSync(join(ws, ".rei", "active.json"), "utf8")).toContain("status-bar");
  });

  it("treats a malformed pointer as 'nothing active' rather than throwing", () => {
    writeFileSync(join(ws, ".rei", "active.json"), "{ not json");
    expect(getActive(ws)).toEqual({});
  });

  it("ignores non-string values", () => {
    writeFileSync(join(ws, ".rei", "active.json"), JSON.stringify({ plan: 42, spec: null }));
    expect(getActive(ws)).toEqual({ spec: undefined, plan: undefined });
  });
});

describe("reading the active plan", () => {
  it("returns the file's content", () => {
    writeFileSync(join(ws, ".rei", "plans", "p.md"), "# Plan\n\n## Stage 1: x\n");
    setActivePlan(ws, "p");
    expect(readActivePlan(ws)).toContain("## Stage 1: x");
  });

  it("returns null when the named file is gone — a dangling pointer is not a crash", () => {
    setActivePlan(ws, "deleted");
    expect(activePlanPath(ws)).toBeNull();
    expect(readActivePlan(ws)).toBeNull();
  });

  it("returns null when nothing is active", () => {
    expect(readActivePlan(ws)).toBeNull();
  });

  it("reflects an edit to the file, since it holds a name and not a copy", () => {
    const file = join(ws, ".rei", "plans", "p.md");
    writeFileSync(file, "# Plan\n\n## Stage 1: first\n");
    setActivePlan(ws, "p");
    writeFileSync(file, "# Plan\n\n## Stage 1: edited\n");
    expect(readActivePlan(ws)).toContain("edited");
  });
});
