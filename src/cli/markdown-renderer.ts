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
