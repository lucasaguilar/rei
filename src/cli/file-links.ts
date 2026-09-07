import * as fs from "node:fs";
import * as path from "node:path";
import { buildFileMatcherRegex } from "../language/language-capabilities.js";

/**
 * Clickable file links — the single place REI decides what counts as a path and where it points.
 *
 * There are two entry points because the callers know different things: a table has resolved its
 * own shortened paths and links after layout; prose links whatever it names. Both go through
 * `resolveLinkTarget`, so "is this a file?" is answered once. Two separate notions of a path used
 * to disagree — one required a slash, the other an extension — and a file linked in a table stayed
 * dead text one line above it.
 */

/**
 * Terminals that render OSC 8 hyperlinks. Everything else gets plain text: an unsupported terminal
 * would show the escape sequence as garbage, which is worse than no link.
 * `REI_HYPERLINKS=off` disables them; `on` forces them for a terminal not listed here.
 */
export function hyperlinksSupported(): boolean {
  const forced = process.env.REI_HYPERLINKS?.toLowerCase();
  if (forced === "off") return false;
  if (forced === "on") return true;
  const program = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  return (
    program.includes("iterm") ||
    program.includes("wezterm") ||
    program.includes("ghostty") ||
    program === "vscode" ||
    Boolean(process.env.KITTY_WINDOW_ID) ||
    process.env.WT_SESSION !== undefined // Windows Terminal
  );
}

/**
 * Wraps text in an OSC 8 hyperlink. The escapes occupy NO columns, which is why this is applied to
 * text that is already laid out: cli-table3 measures a linked cell as 19 columns narrower than it
 * renders, and every border in the table goes out of line.
 */
export function hyperlink(text: string, target: string): string {
  const ESC = "\x1b";
  return `${ESC}]8;;${target}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

/**
 * The absolute file a piece of text points at, or null when it is not a path to a real file.
 *
 * The single definition of "this is a file": one token, carrying a directory or an extension, that
 * exists on disk. Only real files are linked — a link to something absent looks clickable and does
 * nothing, which is worse than plain text.
 */
export function resolveLinkTarget(text: string, root: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!trimmed.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(trimmed)) return null;
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(root, trimmed);
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null; // unreadable → not linkable
  }
}

/**
 * Shortens a path from the MIDDLE, keeping the file name whole.
 *
 * Returns the input untouched when it already fits or has no directory to drop.
 */
export function shortenPath(text: string, max: number): string {
  if (text.length <= max || !text.includes("/")) return text;
  const parts = text.split("/");
  const file = parts[parts.length - 1];
  // The file name alone is already too long: keep its END, which carries the extension.
  if (file.length + 2 > max) return `…${file.slice(-(max - 1))}`;

  // Drop interior directories, the ones nearest the file last, until what remains fits.
  for (let keep = parts.length - 2; keep >= 1; keep--) {
    const candidate = [...parts.slice(0, keep), "…", file].join("/");
    if (candidate.length <= max) return candidate;
  }
  const bare = `…/${file}`;
  return bare.length <= max ? bare : `…${file.slice(-(max - 1))}`;
}

/**
 * Points every path in a rendered table at the real file, so a click opens it.
 *
 * Applied AFTER layout — see `hyperlink`. Only paths that EXIST are linked: a link to a missing
 * file looks clickable and silently does nothing, which is worse than plain text.
 */
export function linkPathsInTable(rendered: string, rows: string[][]): string {
  if (!hyperlinksSupported()) return rendered;
  const root = process.env.REI_WORKSPACE_PATH ?? process.cwd();

  const targets = new Map<string, string>();
  for (const row of rows) {
    for (const cell of row) {
      const abs = resolveLinkTarget(cell, root);
      if (abs) targets.set(cell.trim(), abs);
    }
  }
  if (targets.size === 0) return rendered;

  // Longest first: a short path can be a substring of a longer one, and replacing it first would
  // corrupt the longer match.
  let out = rendered;
  for (const text of [...targets.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split(text).join(hyperlink(text, `file://${targets.get(text)}`));
  }
  return out;
}


/** An OSC 8 sequence, opening or closing. Used to leave already-linked regions alone. */
// eslint-disable-next-line no-control-regex
const OSC8 = /\x1b\]8;;[^\x1b]*\x1b\\/g;

/**
 * Links every file path in a rendered answer, not just the ones in tables.
 *
 * REI names files constantly in prose — "the fix is in src/cli/markdown-renderer.ts" — and those
 * were dead text while the same path inside a table was clickable. Same rule as tables: the escapes
 * occupy no columns, so this runs on text that is already laid out and wrapped.
 *
 * Regions that are ALREADY linked are skipped. A table has resolved its own paths (it alone knows
 * what a shortened path stood for), and wrapping a link inside a link produces neither.
 */
export function linkPathsInText(rendered: string, workspacePath?: string): string {
  if (!hyperlinksSupported() || !rendered) return rendered;
  const root = workspacePath ?? process.env.REI_WORKSPACE_PATH ?? process.cwd();
  const fileRe = buildFileMatcherRegex();

  // Colour codes are split off before matching. `\x1b[36m` ends in "36m", and `3`, `6` and `m` are
  // word characters: the pattern swallowed them and looked for "36msrc/cli/a.ts", so a path inside
  // inline code — the way REI writes most of them — never linked.
  // eslint-disable-next-line no-control-regex
  const SGR = /\x1b\[[0-9;]*m/g;
  const linkSegment = (segment: string): string =>
    segment
      .split(SGR)
      .map((plain) =>
        plain.replace(fileRe, (match) => {
          const abs = resolveLinkTarget(match, root);
          return abs ? hyperlink(match, `file://${abs}`) : match;
        }),
      )
      .reduce((acc, part, i) => acc + (i > 0 ? (segment.match(SGR) ?? [])[i - 1] ?? "" : "") + part, "");

  // Walk the string, linking only what sits outside an existing OSC 8 pair.
  let out = "";
  let cursor = 0;
  let depth = 0;
  for (const m of rendered.matchAll(OSC8)) {
    const isOpen = m[0].length > "\x1b]8;;\x1b\\".length;
    const chunk = rendered.slice(cursor, m.index);
    out += depth === 0 ? linkSegment(chunk) : chunk;
    out += m[0];
    cursor = (m.index ?? 0) + m[0].length;
    depth = isOpen ? depth + 1 : Math.max(0, depth - 1);
  }
  out += depth === 0 ? linkSegment(rendered.slice(cursor)) : rendered.slice(cursor);
  return out;
}
