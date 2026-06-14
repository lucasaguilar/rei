import { describe, it, expect } from "vitest";
import { buildProjectFileTree } from "./turn-message.helpers.js";

describe("buildProjectFileTree", () => {
  it("returns an empty string when there are no files", () => {
    expect(buildProjectFileTree([])).toBe("");
  });

  it("lists every path (sorted) when the listing fits the budget", () => {
    const files = [
      { path: "src/styles.scss" },
      { path: "src/app/components/crypto/crypto.component.ts" },
      { path: "src/main.ts" },
    ];
    const out = buildProjectFileTree(files);
    expect(out).toContain("### PROJECT FILE TREE");
    // Sorted: the components path comes before main.ts / styles.scss.
    const body = out.split("\n\n")[1];
    expect(body).toBe(
      "src/app/components/crypto/crypto.component.ts\n" +
        "src/main.ts\n" +
        "src/styles.scss",
    );
  });

  it("collapses to directory counts when the full listing exceeds the budget", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/app/feature/file${i}.ts`,
    }));
    const out = buildProjectFileTree(files, 200);
    expect(out).toContain("files total");
    expect(out).toMatch(/src\/app\/feature\/ \(50 files\)/);
  });

  it("never exceeds the char budget by more than the header/notes", () => {
    const files = Array.from({ length: 1000 }, (_, i) => ({
      path: `src/module${i % 40}/deeply/nested/file${i}.ts`,
    }));
    const budget = 600;
    const out = buildProjectFileTree(files, budget);
    // Body (after the header line) stays within budget (+ a trailing ellipsis).
    const body = out.split("\n\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(budget + 2);
  });
});
