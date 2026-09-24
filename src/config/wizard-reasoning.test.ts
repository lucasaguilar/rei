import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * The wizard's reasoning step offered three fixed profiles, so a combination as ordinary as
 * `ASK=none PLANNING=low AGENT=low` could not be produced — the answer was to finish the wizard
 * and then correct `.env` by hand, which is the wizard failing at its one job.
 *
 * Loaded from the wizard's real source: it is plain JS that ships standalone to ~/.rei/scripts and
 * cannot be imported, but its logic must not drift unnoticed. Same approach as wizard-defaults.
 */
function loadWizard(): {
  reasoningProfileLevels: (p: string) => Record<string, string> | null;
  levels: Array<string | null>;
} {
  const src = readFileSync(
    fileURLToPath(new URL("../../scripts/launch-rei.js", import.meta.url)),
    "utf8",
  );
  const levels = src.match(/const REASON_LEVELS = \[[^\]]*\];/)?.[0];
  const fn = src.match(/function reasoningProfileLevels[\s\S]*?\n}/)?.[0];
  if (!levels || !fn) {
    throw new Error("reasoning step not found — did launch-rei.js get refactored?");
  }
  return new Function(
    `${levels}\n${fn}\nreturn { reasoningProfileLevels, levels: REASON_LEVELS };`,
  )() as ReturnType<typeof loadWizard>;
}

const { reasoningProfileLevels, levels } = loadWizard();

describe("the wizard's reasoning profiles", () => {
  it("caps the chatty modes and lets the agent reason, on the default profile", () => {
    // Local models think by default, so ask and planning over-think unless capped — that is what
    // makes `balanced` the default rather than `full`.
    expect(reasoningProfileLevels("balanced")).toEqual({
      ASK: "none",
      PLANNING: "none",
      AGENT: "medium",
    });
  });

  it("turns thinking off everywhere on minimal", () => {
    expect(reasoningProfileLevels("minimal")).toEqual({
      ASK: "none",
      PLANNING: "none",
      AGENT: "none",
    });
  });

  it("writes nothing for full, so the model keeps its own default", () => {
    // Not `{}`: null is what tells the caller to skip the variables entirely. An empty object
    // would still be iterated and write nothing, but the distinction is the one that matters if
    // the caller ever starts writing defaults.
    expect(reasoningProfileLevels("full")).toBeNull();
  });

  it("leaves custom to the per-mode prompts", () => {
    expect(reasoningProfileLevels("custom")).toBeNull();
  });
});

describe("the levels the wizard offers", () => {
  it("covers every level REI accepts, plus 'unset'", () => {
    // REI's whitelist is the OpenAI-standard set. A wizard offering fewer is a wizard whose
    // output you have to correct by hand.
    expect(levels).toEqual([null, "none", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("can express a combination no preset reaches", () => {
    // The reported case: ask silent, planning and agent thinking a little.
    const wanted = { ASK: "none", PLANNING: "low", AGENT: "low" };
    for (const level of Object.values(wanted)) expect(levels).toContain(level);
    expect(Object.values(reasoningProfileLevels("balanced") ?? {})).not.toContain("low");
  });
});
