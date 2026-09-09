import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoSummary } from "./helpers/context-builder.helpers.js";

/**
 * The summary tells the model what the repository IS. Build output and dependencies exist in it
 * without describing it, and listing them as part of its shape invites the model to go looking
 * there — the cost is four tokens, the problem is the signal.
 */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-summary-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const dir = (name: string) => mkdirSync(join(ws, name), { recursive: true });

describe("buildRepoSummary", () => {
  it("lists the directories that describe the project", async () => {
    dir("src");
    dir("docs");
    const out = await buildRepoSummary({ workspacePath: ws, fileCount: 10 });
    expect(out).toContain("src");
    expect(out).toContain("docs");
  });

  it("leaves out build output and dependencies", async () => {
    for (const d of ["src", "node_modules", "dist", "build", "target", "vendor", "coverage"]) dir(d);
    const out = await buildRepoSummary({ workspacePath: ws, fileCount: 10 });
    expect(out).toContain("src");
    for (const d of ["node_modules", "dist", "build", "target", "vendor", "coverage"]) {
      expect(out).not.toContain(d);
    }
  });

  it("still leaves out dot-directories", async () => {
    dir("src");
    dir(".git");
    dir(".rei");
    const out = await buildRepoSummary({ workspacePath: ws, fileCount: 10 });
    expect(out).not.toContain(".git");
    expect(out).not.toContain(".rei");
  });

  it("names the project markers it finds", async () => {
    writeFileSync(join(ws, "package.json"), "{}");
    expect(await buildRepoSummary({ workspacePath: ws, fileCount: 0 })).toContain("package.json");
  });

  it("stays small — it is a hint, not a map", async () => {
    for (const d of ["src", "docs", "tools", "scripts", "prompts", "bin"]) dir(d);
    writeFileSync(join(ws, "package.json"), "{}");
    const out = await buildRepoSummary({ workspacePath: ws, fileCount: 500 });
    expect(out.length).toBeLessThan(400);
  });
});
