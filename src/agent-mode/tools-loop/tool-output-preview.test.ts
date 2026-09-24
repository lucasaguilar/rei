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
    const r = retainAndMaybeSpill("fetch", ("B".repeat(99) + "\n").repeat(200));
    const m = r.match(/showing (\d+) of (\d+) lines \((\d+) of (\d+) chars\)/);
    expect(m, `no count line in: ${r.slice(0, 120)}`).not.toBeNull();
    const [, shownLines, totalLines, shownChars, totalChars] = m!.map(Number);
    expect(totalChars).toBe(20_000);
    expect(totalLines).toBe(201); // 200 newline-terminated lines + the empty tail
    expect(shownChars).toBeLessThanOrEqual(2000);
    expect(shownLines).toBeLessThan(totalLines);
    expect(shownLines).toBeGreaterThan(0);
  });

  it("keeps path and id ahead of the preview, so they survive backend truncation", () => {
    const r = retainAndMaybeSpill("fetch", "C".repeat(20_000));
    expect(r.indexOf("path:")).toBeLessThan(r.indexOf("--- preview"));
    expect(r.indexOf("id:")).toBeLessThan(r.indexOf("--- preview"));
  });

  it("is overridable with REI_TOOL_OUTPUT_PREVIEW", () => {
    process.env.REI_TOOL_OUTPUT_PREVIEW = "50";
    expect(retainAndMaybeSpill("fetch", "D".repeat(20_000))).toContain("(50 of 20000 chars)");
  });

  it("names both ways to get the rest back — that is what makes truncating safe", () => {
    const r = retainAndMaybeSpill("fetch", "F".repeat(20_000));
    expect(r).toContain("read_files(");
    expect(r).toContain("save_tool_output(");
  });

  it("spills outside the workspace by default, where nothing has to clean it up", () => {
    delete process.env.REI_TOOL_OUTPUT_DIR;
    const r = retainAndMaybeSpill("fetch", "G".repeat(20_000));
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

/**
 * The inline budget is a share of the CONTEXT WINDOW, not a constant.
 *
 * Measured over 95 real spills in this repo's sessions, the model fetched the spilled file back 66%
 * of the time — so for anything it was going to read anyway, spilling cost an extra turn and left
 * the history holding the preview AND the full output as two near-identical blocks a few messages
 * apart. That shape is repetitive input, which is what feeds a repetition loop. Below the budget the
 * output travels once and the round-trip never happens.
 */
describe("the inline budget scales with the context window", () => {
  afterEach(() => {
    delete process.env.REI_CONTEXT_WINDOW;
    delete process.env.REI_TOOL_OUTPUT_MAX_INLINE;
  });

  it("inlines a mid-size output that used to spill and be fetched right back", () => {
    process.env.REI_CONTEXT_WINDOW = "32768"; // a roomy local window
    const content = "M".repeat(9_000); // the 8–16k band: read back 91% of the time
    expect(retainAndMaybeSpill("run_command", content)).toBe(content);
  });

  it("keeps a small window safe — the share shrinks with it", () => {
    process.env.REI_CONTEXT_WINDOW = "8192";
    // 8192 tokens ≈ 32k chars; 8% of that is ~2.6k, so a 9k output still spills.
    expect(retainAndMaybeSpill("run_command", "N".repeat(9_000))).toContain(
      "Large tool output truncated",
    );
  });

  it("never lets one output eat the window, however big the window is", () => {
    process.env.REI_CONTEXT_WINDOW = "1000000";
    expect(retainAndMaybeSpill("run_command", "O".repeat(200_000))).toContain(
      "Large tool output truncated",
    );
  });

  it("still lets an explicit budget win over the computed one", () => {
    process.env.REI_CONTEXT_WINDOW = "32768";
    process.env.REI_TOOL_OUTPUT_MAX_INLINE = "100";
    expect(retainAndMaybeSpill("run_command", "P".repeat(9_000))).toContain(
      "Large tool output truncated",
    );
  });
});
