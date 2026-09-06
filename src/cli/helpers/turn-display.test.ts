import { describe, it, expect, afterEach } from "vitest";
import { formatEdits, formatThinkingSummary } from "./turn-display.helpers.js";
import { setVerboseOutput } from "../../config/output-verbosity.js";

/**
 * Quiet output is the default. Printing every command's stdout, every diff and the whole reasoning
 * stream buried the two things that matter — which tools ran, and what REI answered — under
 * everything that led to them.
 */
const EDIT = {
  file: "src/auth.ts",
  search: "old line\nsecond old",
  replace: "new line\nsecond new\nthird new",
};

afterEach(() => setVerboseOutput(undefined));

describe("formatEdits", () => {
  it("reports a count per file when quiet, not the hunk", () => {
    setVerboseOutput(false);
    const out = formatEdits([EDIT]).join("\n");
    expect(out).toContain("src/auth.ts");
    expect(out).toContain("+3");
    expect(out).toContain("-2");
    expect(out).not.toContain("old line"); // the hunk itself stays out
  });

  it("shows the full diff when verbose", () => {
    setVerboseOutput(true);
    const out = formatEdits([EDIT]).join("\n");
    expect(out).toContain("old line");
    expect(out).toContain("new line");
  });

  it("says nothing at all when there were no edits", () => {
    setVerboseOutput(false);
    expect(formatEdits([])).toEqual([]);
  });

  it("lists every file, one line each, when quiet", () => {
    setVerboseOutput(false);
    const out = formatEdits([EDIT, { ...EDIT, file: "src/b.ts" }]);
    expect(out.filter((l) => l.includes("src/"))).toHaveLength(2);
  });
});

describe("formatThinkingSummary", () => {
  it("reports the size of the reasoning instead of its content", () => {
    const out = formatThinkingSummary(4000);
    expect(out).toContain("1000 tokens");
    expect(out).toContain("💭");
  });

  it("ends with a newline so it does not run into the next status line", () => {
    expect(formatThinkingSummary(100).endsWith("\n")).toBe(true);
  });
});

describe("setVerboseOutput", () => {
  it("takes precedence over the environment, and clears back to it", () => {
    const saved = process.env.REI_VERBOSE;
    process.env.REI_VERBOSE = "true";
    try {
      setVerboseOutput(false);
      expect(formatEdits([EDIT]).join("\n")).not.toContain("old line");
      setVerboseOutput(undefined); // back to the env
      expect(formatEdits([EDIT]).join("\n")).toContain("old line");
    } finally {
      if (saved === undefined) delete process.env.REI_VERBOSE;
      else process.env.REI_VERBOSE = saved;
    }
  });
});
