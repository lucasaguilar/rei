import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dispatchCommand } from "./registry.js";
import type { CommandContext } from "./command-handler.js";
import { getActive, setActivePlan, setActiveSpec } from "../active-artifacts.js";

/**
 * The active pointer is sticky on purpose — re-running a stage is normal — so the danger is at the
 * other end: a pointer left set after a feature is finished, making a later /runplan execute the OLD
 * plan against new work. Seeing it and clearing it is what makes stickiness safe.
 */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-act-"));
  mkdirSync(join(ws, ".rei", "plans"), { recursive: true });
  mkdirSync(join(ws, ".rei", "specs"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const run = (command: string) =>
  dispatchCommand({ command, workspacePath: ws } as unknown as CommandContext) as Promise<{
    success: boolean;
    response: string;
  } | null>;

describe("/active", () => {
  it("says nothing is active, and how to start", async () => {
    const r = await run("/active");
    expect(r?.response).toContain("Nothing active");
    expect(r?.response).toContain("/spec");
  });

  it("shows both pointers with their file paths", async () => {
    writeFileSync(join(ws, ".rei", "specs", "status-bar.md"), "# Spec");
    writeFileSync(join(ws, ".rei", "plans", "status-bar.md"), "# Plan");
    setActiveSpec(ws, "status-bar");
    setActivePlan(ws, "status-bar");
    const r = await run("/active");
    expect(r?.response).toContain(".rei/specs/status-bar.md");
    expect(r?.response).toContain(".rei/plans/status-bar.md");
    expect(r?.response).not.toContain("file missing");
  });

  it("warns when a pointer outlives its file", async () => {
    setActivePlan(ws, "deleted");
    const r = await run("/active");
    expect(r?.response).toContain("file missing");
  });

  it("clears both by default", async () => {
    setActiveSpec(ws, "a");
    setActivePlan(ws, "b");
    await run("/active clear");
    expect(getActive(ws)).toEqual({ spec: undefined, plan: undefined });
  });

  it("clears only the plan, leaving the spec — the common case after finishing work", async () => {
    setActiveSpec(ws, "a");
    setActivePlan(ws, "b");
    await run("/active clear plan");
    expect(getActive(ws)).toEqual({ spec: "a", plan: undefined });
  });

  it("clears only the spec", async () => {
    setActiveSpec(ws, "a");
    setActivePlan(ws, "b");
    await run("/active clear spec");
    expect(getActive(ws)).toEqual({ spec: undefined, plan: "b" });
  });

  it("accepts 'off' as a synonym for clear", async () => {
    setActivePlan(ws, "b");
    await run("/active off");
    expect(getActive(ws).plan).toBeUndefined();
  });

  it("reports the new state after clearing", async () => {
    setActivePlan(ws, "b");
    const r = await run("/active clear");
    expect(r?.response).toContain("Cleared");
    expect(r?.response).toContain("Nothing active");
  });

  it("does not swallow neighbours", async () => {
    // A different command that merely starts with the same letters is not ours.
    expect(await run("/actives")).toBeNull();
    expect(await run("/activedoc")).toBeNull();
  });

  it("answers a malformed argument with the usage, not 'Unknown command'", async () => {
    // `/active [clear]` is what the help line shows, so it is what people type. Telling them the
    // command does not exist is false: the command is right, the brackets were quoted from its own
    // usage. Same for any other wrong argument.
    for (const wrong of ["/active [clear]", "/active clear everything", "/active spec"]) {
      const r = await run(wrong);
      expect(r?.success, wrong).toBe(false);
      expect(r?.response, wrong).toContain("Usage: /active");
      expect(r?.response, wrong).not.toContain("Unknown command");
    }
  });
});
