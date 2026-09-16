import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshActiveArtifacts, type ContextBar } from "./helpers/startup-gauge.helper.js";
import { setActivePlan, setActiveSpec } from "../chat/active-artifacts.js";

/**
 * The active spec/plan pointer is STICKY on purpose — finishing a plan does not clear it, because
 * re-running a stage is normal. The hazard is the other end: a pointer left set after the feature is
 * done, so the next /runplan executes yesterday's plan against today's work. `/active` answers on
 * demand; this puts it where you cannot help seeing it.
 *
 * Read here and not in the renderer: the pointer lives on disk, and the renderer redraws on every
 * keystroke.
 */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-active-"));
  mkdirSync(join(ws, ".rei", "specs"), { recursive: true });
  mkdirSync(join(ws, ".rei", "plans"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("the 📋 indicator", () => {
  it("shows nothing when nothing is active", () => {
    const state: ContextBar = {};
    refreshActiveArtifacts(state, ws);
    expect(state.activeSpec).toBeUndefined();
    expect(state.activePlan).toBeUndefined();
  });

  it("picks up both pointers", () => {
    writeFileSync(join(ws, ".rei", "specs", "2026-09-16-mi-spec.md"), "# Spec");
    writeFileSync(join(ws, ".rei", "plans", "2026-09-16-mi-spec.md"), "## Stage 1");
    setActiveSpec(ws, "2026-09-16-mi-spec");
    setActivePlan(ws, "2026-09-16-mi-spec");

    const state: ContextBar = {};
    refreshActiveArtifacts(state, ws);
    expect(state.activeSpec).toBe("2026-09-16-mi-spec");
    expect(state.activePlan).toBe("2026-09-16-mi-spec");
    expect(state.activeArtifactsMissing).toBe(false);
  });

  it("flags a pointer whose file is gone", () => {
    // Exactly the state that produced `[TRACE] File not found: .rei/plans/<garbage>.md`: the model
    // wrote the plan under a different name and the pointer was left aiming at a ghost.
    setActivePlan(ws, "un-plan-que-no-existe");
    const state: ContextBar = {};
    refreshActiveArtifacts(state, ws);
    expect(state.activePlan).toBe("un-plan-que-no-existe");
    expect(state.activeArtifactsMissing).toBe(true);
  });

  it("clears the fields when the pointers are unset", () => {
    setActiveSpec(ws, "algo");
    const state: ContextBar = {};
    refreshActiveArtifacts(state, ws);
    expect(state.activeSpec).toBe("algo");

    rmSync(join(ws, ".rei", "active.json"));
    refreshActiveArtifacts(state, ws);
    expect(state.activeSpec).toBeUndefined();
  });
});
