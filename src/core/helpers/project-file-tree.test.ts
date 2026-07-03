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

  it("groups filenames by directory (keeps every name) when the flat listing exceeds the budget", () => {
    // 6 files across 2 dirs: too big for the flat list at this budget, but the grouped view fits.
    const files = [
      { path: "src/cli/ui/chat-renderer.ts" },
      { path: "src/cli/ui/input-handler.ts" },
      { path: "src/cli/ui/keyboard-handler.ts" },
      { path: "src/core/agent.ts" },
      { path: "src/core/logger.ts" },
      { path: "src/core/session.ts" },
    ];
    const out = buildProjectFileTree(files, 120);
    expect(out).toContain("grouped by directory");
    // Filenames are PRESERVED (not collapsed to counts) so the model can see a file exists.
    expect(out).toContain("src/cli/ui/: chat-renderer.ts, input-handler.ts, keyboard-handler.ts");
    expect(out).toContain("src/core/: agent.ts, logger.ts, session.ts");
    expect(out).not.toMatch(/\(\d+ files\)/); // never bare counts
  });

  it("truncates with a discovery hint when even the grouped view exceeds the budget", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `src/app/feature/file${i}.ts`,
    }));
    const out = buildProjectFileTree(files, 200);
    expect(out).toContain("files total");
    expect(out).toContain("git ls-files"); // tells the model how to see the rest
    expect(out).toContain("file0.ts"); // still shows filenames, not counts
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
