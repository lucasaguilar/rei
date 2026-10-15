import { describe, expect, it } from "vitest";
import { formatAppliedEditDiff, formatBatchPatchResult } from "./format-batch-patch-result.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatAppliedEditDiff — the diff shown after an edit lands", () => {
  const diff = formatAppliedEditDiff("src/sum.ts", "let i = 1;", "let i = 0;");

  it("carries no markdown fence: it is printed live, never through the markdown renderer", () => {
    // The CLI shows this chunk as it arrives, so a ```diff fence reached the screen as literal
    // backticks; the server adds its own fence (wrapDiffForMarkdown), so this one doubled it there.
    expect(diff).not.toContain("```");
  });

  it("keeps the File: label first, which is what the server's chat handler looks for", () => {
    expect(plain(diff).trimStart().startsWith("File: src/sum.ts\n")).toBe(true);
  });

  it("stands apart from the report above it, from the next diff and from the answer below it", () => {
    // The fence lines used to do this by accident; without them the diff sat glued to
    // "- src/sum.ts: applied" and to REI's answer. Every block ends its own line and each diff
    // opens with one blank line, so report, diffs and answer come out one blank line apart.
    const report = formatBatchPatchResult({
      success: true,
      results: [{ file: "src/sum.ts", applied: true }],
    } as Parameters<typeof formatBatchPatchResult>[0]);
    const screen = plain(report.trimStart() + diff + diff);
    expect(screen).toContain("- src/sum.ts: applied\n\nFile: src/sum.ts\n");
    expect(screen).toContain("i = 0;\n\nFile: src/sum.ts\n"); // one diff after another
    expect(diff.endsWith("\n")).toBe(true); // the answer's own "\n" then makes the blank line
  });

  it("shows the change as coloured - and + lines", () => {
    expect(diff).toContain("\x1b[31m- let i = 1;");
    expect(diff).toContain("\x1b[32m+ let i = 0;");
  });
});
