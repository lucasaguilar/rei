import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalRules } from "./loader.js";

/**
 * `.rei/rules.md` is per-workspace and nothing else.
 *
 * REI_ROOT/.rei/rules.md was read as a "global" for every workspace, but REI_ROOT is REI's own
 * source tree — so those are the REI repo's rules, not the user's. Running REI in any other project
 * injected REI's Angular/TypeScript conventions as MANDATORY into a repo that uses neither, and
 * working on REI itself loaded them TWICE, since both branches then read the same file.
 */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-rules-"));
  mkdirSync(join(ws, ".rei"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const writeRules = (body: string) => writeFileSync(join(ws, ".rei", "rules.md"), body);

describe("loadLocalRules", () => {
  it("returns nothing for a workspace with no rules file", () => {
    // The important half: a project that declares no rules must receive none — not REI's.
    expect(loadLocalRules(ws)).toBe("");
  });

  it("loads the workspace's own rules under the mandatory heading", () => {
    writeRules("- Use Luau idioms, never TypeScript ones.");
    const out = loadLocalRules(ws);
    expect(out).toContain("MANDATORY CODING RULES");
    expect(out).toContain("Use Luau idioms");
  });

  it("includes each workspace's rules exactly once", () => {
    writeRules("MARKER-ONCE");
    expect((loadLocalRules(ws).match(/MARKER-ONCE/g) ?? []).length).toBe(1);
  });

  it("reads nothing from a different workspace's rules file", () => {
    const other = mkdtempSync(join(tmpdir(), "rei-other-"));
    mkdirSync(join(other, ".rei"), { recursive: true });
    writeFileSync(join(other, ".rei", "rules.md"), "OTHER-PROJECT-RULES");
    try {
      expect(loadLocalRules(ws)).not.toContain("OTHER-PROJECT-RULES");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("treats an empty rules file as no rules", () => {
    writeRules("   \n  ");
    expect(loadLocalRules(ws)).toBe("");
  });

  it("falls back to REI_WORKSPACE_PATH when no path is passed", () => {
    writeRules("FROM-ENV-PATH");
    const saved = process.env.REI_WORKSPACE_PATH;
    process.env.REI_WORKSPACE_PATH = ws;
    try {
      expect(loadLocalRules()).toContain("FROM-ENV-PATH");
    } finally {
      if (saved === undefined) delete process.env.REI_WORKSPACE_PATH;
      else process.env.REI_WORKSPACE_PATH = saved;
    }
  });
});
