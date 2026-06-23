import { describe, it, expect } from "vitest";
import { formatCodeDiff } from "./markdown-renderer.js";

// Strip ANSI so assertions read cleanly.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatCodeDiff", () => {
  it("shows only the changed lines + context, collapsing the rest of a whole-file rewrite", () => {
    // 20 identical lines except line 10 changes — simulates a whole-file rewrite (direct mode)
    // where only one line actually changed.
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "line 10 CHANGED");

    const out = plain(formatCodeDiff(before, after));
    const lines = out.split("\n");

    // The change is shown (both sides of the replace).
    expect(out).toContain("- line 10");
    expect(out).toContain("+ line 10 CHANGED");
    // Context around the change is kept...
    expect(out).toContain("  line 9");
    expect(out).toContain("  line 11");
    // ...but far-away unchanged lines are collapsed, not printed in full.
    expect(out).not.toContain("line 0");
    expect(out).not.toContain("line 19");
    expect(out).toMatch(/unchanged lines/);
    // Output is compact — nowhere near the full 20-line file.
    expect(lines.length).toBeLessThan(12);
  });

  it("shows everything when the unchanged gap is within the context window", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    const out = plain(formatCodeDiff(before, after));
    expect(out).toContain("- b");
    expect(out).toContain("+ B");
    expect(out).toContain("  a");
    expect(out).toContain("  c");
    expect(out).not.toMatch(/unchanged lines/); // nothing to collapse
  });
});
