import { describe, it, expect, afterEach } from "vitest";
import { renderMarkdown } from "./markdown-renderer.js";

/** Visible width of a line, ignoring ANSI color codes (code points, not UTF-16 units). */
const visibleWidth = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const maxLineWidth = (out: string) =>
  Math.max(...out.split("\n").map(visibleWidth));
const tableLines = (out: string) =>
  out.split("\n").filter((l) => /[│┌┬┐├┼┤└┴┘─]/.test(l));

function withColumns<T>(cols: number, fn: () => T): T {
  const stdout = process.stdout as unknown as { columns: number };
  const prev = stdout.columns;
  stdout.columns = cols;
  try {
    return fn();
  } finally {
    stdout.columns = prev;
  }
}

const WIDE_TABLE = [
  "| Path | Archivo | Función principal | Comportamiento | Notas extra |",
  "|---|---|---|---|---|",
  "| nativo | `generator-tools.ts` | `executeAgentTurnWithTools` | reset-on-success consecutivo | la que usa qwen en agente |",
  "| XML | `generator.ts` | `executeAgentTurn` wholefile | per-turn streamWithContinuation | fallback sin tool calls |",
].join("\n");

const NARROW_TABLE = ["| A | B |", "|---|---|", "| x | 1 |", "| y | 2 |"].join("\n");

describe("renderMarkdown — tables fit the terminal width", () => {
  afterEach(() => {
    /* columns restored by withColumns */
  });

  it("reflows a wide table so no line exceeds the terminal width", () => {
    const out = withColumns(80, () => renderMarkdown(WIDE_TABLE));
    expect(maxLineWidth(out)).toBeLessThanOrEqual(80);
    // Box drawing is still intact (borders present, not shattered by a hard wrap).
    expect(out).toContain("┌");
    expect(out).toContain("└");
  });

  it("adapts to a wider terminal", () => {
    const narrow = withColumns(60, () => renderMarkdown(WIDE_TABLE));
    const wide = withColumns(120, () => renderMarkdown(WIDE_TABLE));
    expect(maxLineWidth(narrow)).toBeLessThanOrEqual(60);
    expect(maxLineWidth(wide)).toBeLessThanOrEqual(120);
    // A wider terminal uses more of the available width.
    expect(maxLineWidth(wide)).toBeGreaterThan(maxLineWidth(narrow));
  });

  it("leaves a table that already fits untouched (no forced wrapping)", () => {
    const out = withColumns(80, () => renderMarkdown(NARROW_TABLE));
    // Every cell stays on a single line: exactly one body row per data row (no wrap rows).
    const rows = tableLines(out).filter((l) => l.includes("│"));
    // 1 header row + 2 data rows = 3 content rows (no extra wrapped lines).
    expect(rows).toHaveLength(3);
    expect(maxLineWidth(out)).toBeLessThan(20);
  });

  it("preserves inline styling inside cells (does not leak markdown syntax)", () => {
    const out = withColumns(100, () => renderMarkdown(NARROW_TABLE.replace("| 1 |", "| `c` |")));
    expect(out).not.toContain("`c`"); // backticks consumed by the codespan renderer
    expect(out).toContain("c");
  });
});
