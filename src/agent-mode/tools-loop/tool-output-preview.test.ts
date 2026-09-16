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
// The spill writes into REI_TOOL_OUTPUT_DIR when set, so each test gets its own throwaway dir.
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rei-preview-"));
  process.env.REI_TOOL_OUTPUT_DIR = ws;
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  delete process.env.REI_TOOL_OUTPUT_PREVIEW;
  delete process.env.REI_TOOL_OUTPUT_DIR;
});

describe("spilled-output preview", () => {
  it("shows far more than the old 160 chars", () => {
    const content = "A".repeat(50_000);
    const r = retainAndMaybeSpill("fetch", content);
    const shown = r.slice(r.indexOf("---\n") + 4).split("\n…")[0];
    expect(shown.length).toBe(2000);
  });

  it("states exactly how much is shown, in lines and chars", () => {
    // A model deciding whether to fetch the rest needs the size of what it is missing.
    const r = retainAndMaybeSpill("fetch", ("B".repeat(99) + "\n").repeat(50));
    const m = r.match(/showing (\d+) of (\d+) lines \((\d+) of (\d+) chars\)/);
    expect(m, `no count line in: ${r.slice(0, 120)}`).not.toBeNull();
    const [, shownLines, totalLines, shownChars, totalChars] = m!.map(Number);
    expect(totalChars).toBe(5000);
    expect(totalLines).toBe(51); // 50 newline-terminated lines + the empty tail
    expect(shownChars).toBeLessThanOrEqual(2000);
    expect(shownLines).toBeLessThan(totalLines);
    expect(shownLines).toBeGreaterThan(0);
  });

  it("keeps path and id ahead of the preview, so they survive backend truncation", () => {
    const r = retainAndMaybeSpill("fetch", "C".repeat(9000));
    expect(r.indexOf("path:")).toBeLessThan(r.indexOf("--- preview"));
    expect(r.indexOf("id:")).toBeLessThan(r.indexOf("--- preview"));
  });

  it("is overridable with REI_TOOL_OUTPUT_PREVIEW", () => {
    process.env.REI_TOOL_OUTPUT_PREVIEW = "50";
    expect(retainAndMaybeSpill("fetch", "D".repeat(9000))).toContain("(50 of 9000 chars)");
  });

  it("names both ways to get the rest back — that is what makes truncating safe", () => {
    const r = retainAndMaybeSpill("fetch", "F".repeat(9000));
    expect(r).toContain("read_files(");
    expect(r).toContain("save_tool_output(");
  });

  it("spills outside the workspace by default, where nothing has to clean it up", () => {
    delete process.env.REI_TOOL_OUTPUT_DIR;
    const r = retainAndMaybeSpill("fetch", "G".repeat(9000));
    expect(r).toContain(tmpdir().replace(/\/$/, ""));
  });

  it("leaves small outputs inline and untouched", () => {
    const small = JSON.stringify({ ok: true });
    expect(retainAndMaybeSpill("t", small)).toBe(small);
  });
});

/**
 * `REI_TOOL_OUTPUT_MAX_INLINE` is an inline BUDGET, and 0 is a budget of nothing: no output travels
 * inline at all. The guard used to be `n > 0`, so 0 fell through to the 2000 default — the setting
 * looked broken rather than ignored, and the "how little can the model be given?" end of the knob
 * was unreachable.
 */
describe("the spill threshold honours its extremes", () => {
  afterEach(() => {
    delete process.env.REI_TOOL_OUTPUT_MAX_INLINE;
  });

  it("0 sends NOTHING inline — even a short output spills", () => {
    process.env.REI_TOOL_OUTPUT_MAX_INLINE = "0";
    const r = retainAndMaybeSpill("fetch", "apenas unas palabras");
    expect(r).not.toBe("apenas unas palabras");
    expect(r).toContain("Large tool output truncated");
  });

  it("0 paired with a 0 preview leaves the receipt alone, with no excerpt", () => {
    process.env.REI_TOOL_OUTPUT_MAX_INLINE = "0";
    process.env.REI_TOOL_OUTPUT_PREVIEW = "0";
    const r = retainAndMaybeSpill("fetch", "D".repeat(5_000));
    expect(r).toContain("Large tool output truncated");
    expect(r).not.toContain("DDDD");
    delete process.env.REI_TOOL_OUTPUT_PREVIEW;
  });

  it("without the override, a big output is still spilled", () => {
    const content = "B".repeat(50_000);
    const r = retainAndMaybeSpill("fetch", content);
    expect(r).not.toBe(content);
    expect(r).toContain("Large tool output truncated");
  });

  it("honours an explicit threshold", () => {
    process.env.REI_TOOL_OUTPUT_MAX_INLINE = "10";
    expect(retainAndMaybeSpill("fetch", "0123456789")).toBe("0123456789"); // exactly at the limit
    expect(retainAndMaybeSpill("fetch", "0123456789X")).toContain("Large tool output truncated");
  });

  it("falls back to the default for a value that is a mistake, not a choice", () => {
    for (const bad of ["-1", "abc", "  "]) {
      process.env.REI_TOOL_OUTPUT_MAX_INLINE = bad;
      const r = retainAndMaybeSpill("fetch", "C".repeat(50_000));
      expect(r, bad).toContain("Large tool output truncated");
    }
  });
});
