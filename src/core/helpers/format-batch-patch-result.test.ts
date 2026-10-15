import { describe, expect, it } from "vitest";
import { formatAppliedEditDiff } from "./format-batch-patch-result.js";

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

  it("shows the change as coloured - and + lines", () => {
    expect(diff).toContain("\x1b[31m- let i = 1;");
    expect(diff).toContain("\x1b[32m+ let i = 0;");
  });
});
