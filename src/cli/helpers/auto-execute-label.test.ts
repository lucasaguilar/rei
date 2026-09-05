import { describe, it, expect } from "vitest";
import { autoExecuteLabel } from "./input-command.helpers.js";

describe("autoExecuteLabel", () => {
  it("labels each SDD command with its own tag, not runplan's", () => {
    // The regression: the label was derived from a /\[RUNPLAN STAGE (\d+)\]/ match with "[RUNPLAN]"
    // as the fallback, so every /spec and /decompose turn was announced as "[RUNPLAN]".
    expect(autoExecuteLabel("[SPEC] Write the spec…", "/spec agregar login")).toBe("[SPEC]");
    expect(autoExecuteLabel("[DECOMPOSE] Turn the spec…", "/decompose")).toBe("[DECOMPOSE]");
  });

  it("keeps the runplan labels it already produced", () => {
    expect(autoExecuteLabel("[RUNPLAN] Execute the plan…", "/runplan")).toBe("[RUNPLAN]");
    expect(autoExecuteLabel("[RUNPLAN STAGE 2] Execute stage 2…", "/runplan stage 2")).toBe(
      "[RUNPLAN STAGE 2]",
    );
  });

  it("falls back to what the user typed when the prompt carries no tag", () => {
    expect(autoExecuteLabel("plain prompt with no tag", "/algo")).toBe("/algo");
    // A tag has to open the prompt — one appearing mid-text is not the turn's label.
    expect(autoExecuteLabel("see [RUNPLAN] below", "/algo")).toBe("/algo");
  });
});
