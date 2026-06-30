import { describe, it, expect } from "vitest";
import { buildSystemMessage } from "./prompt-builder.js";

// Markers unique to each mode-prompt variant. We assert the SWAP between the XML mode prompt and
// the native *-tools mode prompt — NOT a blanket scan of the whole system message, because the
// user's own `.rei/rules.md` (loaded for every mode) may legitimately mention XML tags.
const XML_MARKERS: Record<"ask" | "planning", RegExp> = {
  ask: /Requesting File Context/i, // ask.md XML section header
  planning: /Use the XML tag format/i, // planning.md XML tool-call instruction
};

describe("buildSystemMessage — native vs XML tool guidance for ask/planning", () => {
  for (const mode of ["ask", "planning"] as const) {
    it(`${mode}: XML path loads the XML mode prompt`, () => {
      const prompt = buildSystemMessage(mode, undefined, false);
      expect(prompt).toMatch(XML_MARKERS[mode]);
      expect(prompt).not.toMatch(/structured tool calling/i);
    });

    it(`${mode}: native path loads the *-tools prompt (no XML tag instructions)`, () => {
      const prompt = buildSystemMessage(mode, undefined, true);
      expect(prompt).toMatch(/structured tool calling/i);
      expect(prompt).toMatch(/read_files/);
      // The XML mode-prompt instructions must be gone — those are what drag the model into
      // reading files with capped `cat`/`sed` instead of the native read_files tool.
      expect(prompt).not.toMatch(XML_MARKERS[mode]);
    });
  }

  it("agent: native path loads the agent-tools prompt (unchanged behavior)", () => {
    const prompt = buildSystemMessage("agent", undefined, true);
    expect(prompt).toMatch(/AGENT mode with structured tool calling/i);
  });
});
