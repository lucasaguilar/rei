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

  it("keeps a file path whole instead of truncating it to fit", () => {
    // Widths were shared in proportion to natural width, so a short "Archivo" column beside a long
    // description got ~9 chars — and a path has no space to wrap on, so cli-table3 cut it to
    // "install-…". Each column now claims at least its longest unwrappable token.
    const md =
      "| Archivo | Descripción |\n|---|---|\n" +
      "| install-rei-cli-local.sh | Añade el parámetro scope y carga el install filtrado, " +
      "lee la ubicación canónica y mantiene la legada. |\n";
    const out = withColumns(76, () => renderMarkdown(md));
    expect(out).toContain("install-rei-cli-local.sh");
    expect(out).not.toContain("install-…");
  });

  it("does not let one long-token column swallow the table", () => {
    // The floor is capped, so a very long identifier cannot starve the other columns.
    const md =
      "| Symbol | Note |\n|---|---|\n" +
      "| aVeryLongUnbreakableIdentifierThatGoesOnAndOnForever | short |\n";
    const out = withColumns(60, () => renderMarkdown(md));
    expect(maxLineWidth(out)).toBeLessThanOrEqual(60);
    expect(out).toContain("short");
  });

  it("never breaks an ANSI escape across lines", () => {
    // cli-table3's break-anywhere wrapping is not ANSI-aware and prints a raw "[0m" into the cell,
    // so it is deliberately not used as a fallback.
    const md =
      "| Archivo | Descripción |\n|---|---|\n" +
      "| src/some/very/long/path/to/a/file.ts | Usa `is_machine_scoped()` y `load_env_file()` " +
      "para filtrar el entorno del install. |\n";
    const out = withColumns(44, () => renderMarkdown(md));
    // A split escape leaves the tail visible as literal text once the complete codes are stripped.
    // eslint-disable-next-line no-control-regex
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/\[\d+m/);
  });

  it("restores colons escaped inside inline code by marked-terminal", () => {
    // marked-terminal rewrites every ":" in a codespan to "*#COLON|*" so its emoji pass cannot
    // eat ":word:", and undoes it in the transform its own table renderer applies. This renderer
    // replaces that one, so without an explicit restore the placeholder reaches the screen.
    const out = withColumns(100, () =>
      renderMarkdown("| campo | valor |\n|---|---|\n| `arrayBuffer:` | `{buffer: x}` |\n"),
    );
    expect(out).not.toContain("COLON");
    expect(out).toContain("arrayBuffer:");
    expect(out).toContain("{buffer: x}");
  });
});
