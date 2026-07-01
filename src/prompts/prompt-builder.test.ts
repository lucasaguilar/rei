import { describe, it, expect } from "vitest";
import { buildSystemMessage } from "./prompt-builder.js";

// The XML interception path was removed: every mode now uses its native `*-tools` prompt
// unconditionally. These assert the native prompt is selected and carries no XML-tag instructions.
// (We check the mode-prompt markers, not a blanket scan — the user's own `.rei/rules.md`, loaded for
// every mode, may legitimately mention XML tags.)
const XML_MODE_MARKERS: Record<"ask" | "planning", RegExp> = {
  ask: /Requesting File Context/i, // the old ask.md XML section header
  planning: /Use the XML tag format/i, // the old planning.md XML tool-call instruction
};

describe("buildSystemMessage — native tool prompts", () => {
  for (const mode of ["ask", "planning"] as const) {
    it(`${mode}: loads the *-tools prompt with no XML tag instructions`, () => {
      const prompt = buildSystemMessage(mode, undefined);
      expect(prompt).toMatch(/structured tool calling/i);
      expect(prompt).toMatch(/read_files/);
      expect(prompt).not.toMatch(XML_MODE_MARKERS[mode]);
    });
  }

  it("agent: loads the agent-tools prompt", () => {
    const prompt = buildSystemMessage("agent", undefined);
    expect(prompt).toMatch(/AGENT mode with structured tool calling/i);
  });
});
