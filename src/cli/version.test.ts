import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getVersion, getVersionLine } from "./version.js";

/**
 * `rei --version` said `0.1.0` and nothing more — a number that had not changed in months. With
 * REI installed on two machines from two different builds, both reported the same string, and
 * "which build is this?" could only be answered by grepping dist/ for a remembered phrase. It cost
 * half a day of cross-machine debugging before the answer turned out to be "a stale install".
 *
 * The stamp is written per build, so these drive it through a real file rather than a mock: what
 * breaks in practice is the file being absent or half-written, not the formatting.
 */
const STAMP = join(process.cwd(), ".build-info.json");
const saved = existsSync(STAMP) ? readFileSync(STAMP, "utf-8") : null;

afterEach(() => {
  if (saved === null) {
    if (existsSync(STAMP)) unlinkSync(STAMP);
  } else {
    writeFileSync(STAMP, saved);
  }
});

const stamp = (info: unknown) => writeFileSync(STAMP, JSON.stringify(info));

describe("getVersionLine", () => {
  it("names the commit and when it was built", () => {
    stamp({ commit: "ed95a6a", dirty: false, builtAt: "2026-09-19T15:39:00.000Z" });
    const line = getVersionLine();
    expect(line).toContain(getVersion());
    expect(line).toContain("ed95a6a");
    expect(line).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("marks a build made with uncommitted edits", () => {
    // The hash alone would misdescribe what is running, which is the whole point of the line.
    stamp({ commit: "ed95a6a", dirty: true, builtAt: "2026-09-19T15:39:00.000Z" });
    expect(getVersionLine()).toContain("ed95a6a+dirty");
  });

  it("falls back to the bare version when the tree was never built", () => {
    if (existsSync(STAMP)) unlinkSync(STAMP);
    expect(getVersionLine()).toBe(getVersion());
  });

  it("says nothing it does not know when the stamp has no commit", () => {
    // The rsync install writes this placeholder when git is unavailable and nothing was stamped.
    stamp({ commit: null, builtAt: "2026-09-19T15:39:00.000Z" });
    expect(getVersionLine()).toBe(getVersion());
  });

  it("survives a corrupt stamp instead of taking the CLI down with it", () => {
    writeFileSync(STAMP, "{ not json");
    expect(getVersionLine()).toBe(getVersion());
  });
});
