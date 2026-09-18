import { diffLines } from 'diff';
import { code, paint, RESET } from "./theme/palette.js";
import { linkPathsInTable, linkPathsInText, shortenPath } from "./file-links.js";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import Table from "cli-table3";

// ANSI escape helpers
const b = (s: string): string => `\x1b[1m${s}\x1b[0m`;        // bold
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;       // dim/gray
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
const cyanBold = (s: string): string => `\x1b[1;36m${s}\x1b[0m`;
const yellowBold = (s: string): string => `\x1b[1;33m${s}\x1b[0m`;
const blueBold = (s: string): string => `\x1b[1;34m${s}\x1b[0m`;
const italic = (s: string): string => `\x1b[3m${s}\x1b[0m`;
const underline = (s: string): string => `\x1b[4;34m${s}\x1b[0m`;

/**
 * Formats a code difference between search and replace blocks.
 * Uses ANSI color codes to highlight additions (green) and deletions (red).
 */
// Unchanged lines kept around each change, git-style. Whole-file rewrites (the agent loop's
// direct-mode edits) otherwise diff the ENTIRE file; this keeps the output to just the hunks.
const DIFF_CONTEXT_LINES = 3;

export function formatCodeDiff(search: string, replace: string): string {
  const diff = diffLines(search, replace);
  const out: string[] = [];

  const toLines = (value: string): string[] => {
    const lines = value.split('\n');
    // Remove trailing empty string caused by split on a trailing newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  diff.forEach((part, i) => {
    const lines = toLines(part.value);

    if (part.added || part.removed) {
      const color = part.added ? '\x1b[32m' : '\x1b[31m';
      const prefix = part.added ? '+' : '-';
      lines.forEach((line) => out.push(`${color}${prefix} ${line}\x1b[0m`));
      return;
    }

    // Unchanged block: show only DIFF_CONTEXT_LINES next to an adjacent change and collapse
    // the rest, so a whole-file rewrite stays focused on what actually changed.
    const prevChanged = i > 0 && (diff[i - 1].added || diff[i - 1].removed);
    const nextChanged =
      i < diff.length - 1 && (diff[i + 1].added || diff[i + 1].removed);
    const top = prevChanged ? DIFF_CONTEXT_LINES : 0;
    const bottom = nextChanged ? DIFF_CONTEXT_LINES : 0;

    if (top + bottom >= lines.length) {
      lines.forEach((line) => out.push(`  ${line}`));
      return;
    }
    for (let k = 0; k < top; k++) out.push(`  ${lines[k]}`);
    const hidden = lines.length - top - bottom;
    out.push(`\x1b[90m    … ${hidden} unchanged line${hidden === 1 ? '' : 's'} …\x1b[0m`);
    for (let k = lines.length - bottom; k < lines.length; k++) out.push(`  ${lines[k]}`);
  });

  return out.join('\n');
}

/**
 * One-line visual context-usage gauge (bar + %), or null when no window is configured.
 * `promptTokens` = tokens sent (or about to be); `ctxWindow` = assumed context window.
 * Color: green < 60%, yellow 60–85%, red > 85% (close to overflow).
 */
export function formatContextGauge(
  promptTokens: number,
  ctxWindow: number,
  modelLabel?: string,
): string | null {
  if (ctxWindow <= 0) return null;
  const pct = Math.min(100, Math.round((promptTokens / ctxWindow) * 100));
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const suffix = modelLabel ? ` | ${modelLabel}` : "";
  return paint(
    "muted", // same weight as the prep line printed below it
    `⏳ Context: ${promptTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens  [${bar}] ${pct}% used${suffix}`,
  );
}

/**
 * The same reading, compressed to one short line for the STICKY status bar.
 *
 * The full gauge is printed once per turn and scrolls away with everything else, so the number you
 * want when deciding whether to `/clear` is never the one on screen. This version lives in the
 * redrawn block above the prompt, where it stays: `12.4k/100k · 12% · lmstudio/ornith`.
 *
 * Returns null when no window is configured — a bar with no denominator says nothing.
 */
export function formatContextBar(
  promptTokens: number,
  ctxWindow: number,
  modelLabel?: string,
): string | null {
  if (ctxWindow <= 0) return null;
  const pct = Math.min(100, Math.round((promptTokens / ctxWindow) * 100));
  // Colour carries the urgency so the line itself can stay short: dim until it matters.
  const tone = pct > 85 ? code("danger") : pct > 60 ? code("warn") : code("dim");
  const compact = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  const model = modelLabel ? ` ${paint("dim", "·")} ${paint("dim", modelLabel)}` : "";
  return `${tone}${compact(promptTokens)}/${compact(ctxWindow)} · ${pct}%${RESET}${model}`;
}

/**
 * Styles heading text that arrives with its "#" prefix already included
 * by marked-terminal (showSectionPrefix: true by default).
 *   H1 → firstHeading()
 *   H2-H6 → heading() — this function
 */
function styleHeading(s: string): string {
  const match = /^(#{2,6})\s*(.*)$/.exec(s.trim());
  if (!match) return b(s);
  const level = match[1].length;
  const text = match[2];
  return level === 2
    ? cyanBold(`## ${text}`)
    : yellowBold(`${"#".repeat(level)} ${text}`);
}

/** Visible width of a string, ignoring ANSI color codes and counting code points (not UTF-16 units). */
function visibleWidth(s: string): number {
  return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

/**
 * Width of the longest run without spaces — the narrowest a column can get before its content stops
 * being wrappable. A file path or an identifier has no word boundary to break on, so cli-table3
 * TRUNCATES it ("install-…") instead of wrapping. Prose has boundaries everywhere and wraps fine.
 */
function atomicWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let longest = 0;
  for (const token of plain.split(/\s+/)) longest = Math.max(longest, [...token].length);
  return longest;
}

/** Fallback terminal width when stdout isn't a TTY (piped output, tests). */
const FALLBACK_COLS = 80;
/** Never shrink a column below this many content chars, even on a very narrow terminal. */
const MIN_COL_CONTENT = 6;

/**
 * Custom Markdown table renderer. marked-terminal sizes tables to their CONTENT with no cap, so a
 * wide table (REI's technical comparisons) overflows the terminal — which then hard-wraps each
 * line, shattering the box drawing. Here we only constrain when the natural table would overflow
 * `process.stdout.columns`: distribute the available width across columns (proportional to content,
 * min MIN_COL_CONTENT) and let cli-table3 word-wrap cells. Tables that already fit are left at their
 * natural size, so the common case is unchanged. Read at render time so terminal resizes are honored.
 */
function renderTable(this: { parser: { parseInline(tokens: unknown): string } }, token: {
  header: Array<{ tokens: unknown }>;
  rows: Array<Array<{ tokens: unknown }>>;
  align: Array<"left" | "center" | "right" | null>;
}): string {
  // marked-terminal escapes every ":" inside inline code (its emoji pass would otherwise turn
  // ":word:" into a glyph) and undoes it in the transform chain its own table renderer applies.
  // This renderer replaces that one, so the colons have to be restored here or the placeholder
  // reaches the screen. REI sets emoji:false, so the escape protects nothing to begin with.
  const inline = (cell: { tokens: unknown }) =>
    this.parser
      .parseInline(cell.tokens)
      .replace(/\n/g, " ")
      .replace(/\*#COLON\|\*/g, ":");
  const header = token.header.map(inline);
  const rows = token.rows.map((r) => r.map(inline));
  const n = header.length;
  if (n === 0) return "";

  const natural = header.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  );
  // cli-table3 total width = sum(colWidths) + (n+1) borders; each colWidth = content + 2 padding.
  const overhead = 3 * n + 1;
  const naturalTotal = natural.reduce((a, b) => a + b, 0) + overhead;
  const termWidth =
    process.stdout.columns && process.stdout.columns > 0
      ? process.stdout.columns
      : FALLBACK_COLS;

  const colAligns = token.align.map((a) => a ?? "left");
  const opts: Table.TableConstructorOptions = {
    head: header,
    colAligns,
    wordWrap: true,
    wrapOnWordBoundary: true,
  };

  if (naturalTotal > termWidth) {
    const avail = Math.max(termWidth - overhead, n * MIN_COL_CONTENT);
    const totalContent = natural.reduce((a, b) => a + b, 0) || 1;
    const raw = natural.map((w) => (w / totalContent) * avail);

    // Proportional shares alone starve a narrow column of unbreakable content: a "Archivo" column
    // next to a long description got ~9 chars and every path came out as "install-…". Each column
    // therefore claims at least its longest unwrappable token — capped so one column cannot take
    // the table, and never more than the column actually needs.
    const atomics = header.map((h, i) =>
      Math.max(atomicWidth(h), ...rows.map((r) => atomicWidth(r[i] ?? ""))),
    );
    // Two thirds, not a half: a column of file paths sitting next to a prose column needs most of
    // what it asks for, and prose survives a narrow column far better than a path does.
    const atomicCap = Math.max(MIN_COL_CONTENT, Math.floor((avail * 2) / 3));
    const floors = atomics.map((a, i) =>
      Math.max(MIN_COL_CONTENT, Math.min(atomicCap, natural[i], a)),
    );
    // When the floors do not fit, they are scaled down together rather than dropped — the widest
    // gives up the most, and the fallback below keeps the overflow readable.
    const floorTotal = floors.reduce((a, b) => a + b, 0);
    const scaled =
      floorTotal > avail
        ? floors.map((f) => Math.max(MIN_COL_CONTENT, Math.floor((f / floorTotal) * avail)))
        : floors;

    const widths = raw.map((x, i) => Math.max(scaled[i], Math.floor(x)));
    // NOT falling back to wrapOnWordBoundary:false when a token still overflows: cli-table3's
    // break-anywhere path is not ANSI-aware and splits colour escapes mid-sequence, printing the
    // raw "[0m" into the cell. A clean ellipsis beats corrupted output.

    // Balance to sum EXACTLY `avail` (so the table is exactly termWidth). Forcing narrow columns up
    // to MIN_COL_CONTENT can overshoot, so we may need to give back as well as hand out.
    let diff = avail - widths.reduce((a, b) => a + b, 0);
    // Hand the rounding leftover to the columns that lost the most fractional width.
    const byRemainder = raw
      .map((x, i) => [x - Math.floor(x), i] as const)
      .sort((a, b) => b[0] - a[0]);
    for (let k = 0; diff > 0; k = (k + 1) % n, diff--) {
      widths[byRemainder[k][1]]++;
    }
    // Overshot: shave from the widest column, in two passes. The first respects each column's floor
    // so a path column keeps its width; the second ignores floors, because the table must never be
    // wider than the terminal — a wrapped border is worse than a truncated cell.
    for (const floor of [scaled, header.map(() => MIN_COL_CONTENT)]) {
      while (diff < 0) {
        let widest = -1;
        for (let i = 0; i < n; i++) {
          if (widths[i] > floor[i] && (widest < 0 || widths[i] > widths[widest])) {
            widest = i;
          }
        }
        if (widest < 0) break; // everything already at this pass's floor
        widths[widest]--;
        diff++;
      }
    }
    opts.colWidths = widths.map((w) => w + 2);

    // With each column's width known, shorten any path that still does not fit — from the middle,
    // so the file name survives. cli-table3 would cut the end, dropping what identifies the file.
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const cell = row[i] ?? "";
        if (visibleWidth(cell) > widths[i] && atomicWidth(cell) > widths[i]) {
          row[i] = shortenPath(cell, widths[i]);
        }
      }
    }
  }

  const table = new Table(opts);
  for (const r of rows) table.push(r);
  return "\n" + linkPathsInTable(table.toString(), rows) + "\n";
}

let initialized = false;

function ensureInit(): void {
  if (initialized) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marked.use(markedTerminal({
    // Code blocks: keep marked-terminal's built-in cli-highlight for syntax
    // coloring; only override the fallback style (plain text / unknown lang)
    code: dim,
    // Inline code
    codespan: (s: string) => cyan(s),
    // Headings
    heading: styleHeading,
    firstHeading: (s: string) => blueBold(s),
    // Text decorations
    strong: b,
    em: italic,
    del: (s: string) => `\x1b[9m${s}\x1b[0m`,
    // Links
    link: underline,
    href: underline,
    // Blockquote: left bar
    blockquote: (s: string) =>
      s
        .split("\n")
        .map((l: string) => dim("▎ ") + l)
        .join("\n") + "\n",
    tab: 2,
    unescape: true,
    emoji: false,
  }) as any);

  // Override marked-terminal's table renderer with our terminal-width-aware one (must come AFTER
  // markedTerminal so it wins). Keeps cli-table3's look but reflows wide tables instead of letting
  // the terminal hard-wrap and break the box drawing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marked.use({ renderer: { table: renderTable as any } });

  initialized = true;
}

/**
 * Renders a markdown string to formatted terminal output with ANSI colors,
 * syntax-highlighted code blocks, and proper spacing — similar to Cursor CLI.
 */
export function renderMarkdown(text: string): string {
  ensureInit();
  const rendered = marked(text);
  if (typeof rendered !== "string") {
    return text;
  }
  // Link file paths LAST, over the laid-out text: OSC 8 escapes occupy no columns, so wrapping is
  // already settled and nothing shifts. Tables have linked their own paths and are skipped.
  return linkPathsInText(rendered.trimEnd());
}
