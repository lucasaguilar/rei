import { diffLines } from 'diff';
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

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
  return rendered.trimEnd();
}
