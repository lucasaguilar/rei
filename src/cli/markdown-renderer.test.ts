import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderMarkdown } from "./markdown-renderer.js";
import { shortenPath } from "./table-links.js";

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

describe("shortenPath", () => {
  it("drops interior directories, keeping the file name whole", () => {
    // cli-table3 cuts from the end, removing exactly the part that says WHICH file it is — and a
    // terminal cannot resolve the truncated text as a link either.
    expect(shortenPath("smart-forms/components/record-filters/x.component.ts", 40)).toContain(
      "x.component.ts",
    );
    expect(shortenPath("smart-forms/components/record-filters/x.component.ts", 40)).toContain("…");
  });

  it("gives back a path that already fits, untouched", () => {
    expect(shortenPath("src/a.ts", 40)).toBe("src/a.ts");
  });

  it("keeps as many leading directories as the width allows", () => {
    const wide = shortenPath("a/b/c/d/e/file.ts", 40);
    const narrow = shortenPath("a/b/c/d/e/file.ts", 14);
    expect(wide.length).toBeLessThanOrEqual(40);
    expect(narrow.length).toBeLessThanOrEqual(14);
    // More room ⇒ more of the original prefix survives.
    expect(wide.length).toBeGreaterThanOrEqual(narrow.length);
    expect(narrow).toContain("file.ts");
  });

  it("keeps the extension when even the file name does not fit", () => {
    const out = shortenPath("a/b/a-very-long-component-name.component.ts", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(".ts")).toBe(true);
  });

  it("leaves something without a directory alone", () => {
    // Not a path: there is no interior to drop, so cli-table3's own cut is the right behaviour.
    expect(shortenPath("aVeryLongIdentifierWithNoSlashes", 10)).toBe(
      "aVeryLongIdentifierWithNoSlashes",
    );
  });

  it("never returns more than the width it was given", () => {
    for (const w of [8, 12, 20, 30, 50]) {
      expect(shortenPath("a/b/c/d/e/f/g/some-file.component.spec.ts", w).length)
        .toBeLessThanOrEqual(w);
    }
  });
});

describe("file hyperlinks in tables", () => {
  const md = (rows: string) => `| Archivo | Nota |\n|---|---|\n${rows}`;
  const links = (out: string): string[] =>
    // eslint-disable-next-line no-control-regex
    [...out.matchAll(/\x1b\]8;;file:\/\/([^\x1b]*)/g)].map((m) => m[1]);

  let savedFlag: string | undefined;
  let savedWs: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.REI_HYPERLINKS;
    savedWs = process.env.REI_WORKSPACE_PATH;
    process.env.REI_HYPERLINKS = "on";
    process.env.REI_WORKSPACE_PATH = process.cwd();
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.REI_HYPERLINKS;
    else process.env.REI_HYPERLINKS = savedFlag;
    if (savedWs === undefined) delete process.env.REI_WORKSPACE_PATH;
    else process.env.REI_WORKSPACE_PATH = savedWs;
  });

  it("points a path at the real file, absolute", () => {
    const out = withColumns(90, () => renderMarkdown(md("| package.json | ok |\n")));
    expect(links(out)).toHaveLength(1);
    expect(links(out)[0].endsWith("/package.json")).toBe(true);
  });

  it("links a path even when it was NOT shortened", () => {
    // Clicking should always open the file; fitting the column is not what makes a path worth
    // linking.
    const out = withColumns(200, () => renderMarkdown(md("| package.json | ok |\n")));
    expect(links(out)).toHaveLength(1);
  });

  it("leaves a path that does not exist unlinked", () => {
    // A link to a missing file looks clickable and does nothing — worse than plain text.
    const out = withColumns(90, () => renderMarkdown(md("| smart-forms/nope.ts | x |\n")));
    expect(links(out)).toHaveLength(0);
  });

  it("does not break the table's alignment", () => {
    // cli-table3 measures the escapes as content, so they are applied AFTER layout. A linked cell
    // measured 19 columns narrower than it rendered and pulled every border out of line.
    const out = withColumns(90, () => renderMarkdown(md("| package.json | ok |\n| README.md | ok |\n")));
    // Compared with the escapes stripped: they occupy no columns on screen, so a row carrying a
    // link must measure the same as one without.
    // eslint-disable-next-line no-control-regex
    const bare = (l: string) => l.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    const rows = tableLines(out).filter((l) => l.includes("│")).map(bare);
    expect(new Set(rows.map((l) => l.length)).size).toBe(1);
  });

  it("emits nothing when hyperlinks are turned off", () => {
    process.env.REI_HYPERLINKS = "off";
    const out = withColumns(90, () => renderMarkdown(md("| package.json | ok |\n")));
    expect(links(out)).toHaveLength(0);
  });
});
