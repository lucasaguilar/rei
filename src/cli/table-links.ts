import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Clickable file links in tables, and shortening a path so its name survives the cut.
 *
 * Both halves exist for one reason: a table of file paths is only useful if you can tell WHICH file
 * each row is, and reach it. cli-table3 cuts from the end, which removes exactly the identifying
 * part — a column of `smart-forms/components/record-filters/smart-form-record-filte…` says nothing.
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
      const text = cell.trim();
      // A single token that looks like a file: it has a directory, or it carries an extension.
      // `package.json` is as worth linking as `src/a/b.ts`.
      if (!text || /\s/.test(text)) continue;
      if (!text.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(text)) continue;
      const abs = path.isAbsolute(text) ? text : path.join(root, text);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) targets.set(text, abs);
      } catch {
        /* unreadable → not linkable */
      }
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
