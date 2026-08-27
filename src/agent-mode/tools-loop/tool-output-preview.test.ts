import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { retainAndMaybeSpill } from "./tool-output-store.js";

/**
 * When a tool output is spilled to disk the model only sees the receipt, so the preview is its only
 * clue about WHAT was fetched. At 160 chars a JSON response showed nothing but opening metadata
 * (`{"expand":"renderedFields,names,…`) and prose was cut mid-sentence, which pushed the model into
 * re-reading the whole file just to find out what it had.
 */
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "rei-preview-")); });
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  delete process.env.REI_TOOL_OUTPUT_PREVIEW;
});

describe("spilled-output preview", () => {
  it("shows far more than the old 160 chars", () => {
    const content = "A".repeat(50_000);
    const r = retainAndMaybeSpill("fetch", content, ws);
    const shown = r.slice(r.indexOf("---\n") + 4).split("\n…")[0];
    expect(shown.length).toBe(2000);
  });

  it("states how much is shown and how much was left out", () => {
    const r = retainAndMaybeSpill("fetch", "B".repeat(5000), ws);
    expect(r).toContain("--- preview (2000 of 5000 chars) ---");
    expect(r).toContain("… 3000 more chars are in the file above.");
  });

  it("keeps path and id ahead of the preview, so they survive backend truncation", () => {
    const r = retainAndMaybeSpill("fetch", "C".repeat(9000), ws);
    expect(r.indexOf("path:")).toBeLessThan(r.indexOf("--- preview"));
    expect(r.indexOf("id:")).toBeLessThan(r.indexOf("--- preview"));
  });

  it("is overridable with REI_TOOL_OUTPUT_PREVIEW", () => {
    process.env.REI_TOOL_OUTPUT_PREVIEW = "50";
    const r = retainAndMaybeSpill("fetch", "D".repeat(9000), ws);
    expect(r).toContain("--- preview (50 of 9000 chars) ---");
  });

  it("does not claim omitted chars when the preview covers everything", () => {
    process.env.REI_TOOL_OUTPUT_PREVIEW = "100000";
    const r = retainAndMaybeSpill("fetch", "E".repeat(3000), ws);
    expect(r).toContain("--- preview (3000 of 3000 chars) ---");
    expect(r).not.toContain("more chars are in the file");
  });

  it("leaves small outputs inline and untouched", () => {
    const small = JSON.stringify({ ok: true });
    expect(retainAndMaybeSpill("t", small, ws)).toBe(small);
  });
});
