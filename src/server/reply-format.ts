/**
 * @fileoverview A public channel's reply, as the channel can show it. Models write markdown out of
 * habit, and asking them not to is unreliable; the channel fixes it after the fact instead:
 *
 *  - `plain` (the web widget, which shows text as typed): the markup goes, the text stays.
 *  - `whatsapp`: WhatsApp's own markup — `*bold*`, `_italic_`, `` `code` `` — and no headings,
 *    tables or markdown links, which it shows raw.
 *
 * Then `capReply` holds the reply to the persona's `maxReplyChars`, which the model is only asked
 * to respect.
 *
 * @module rei/server/reply-format
 */

export type ReplyFormat = "plain" | "whatsapp";

/** The model is asked for "about" maxReplyChars: a reply a little over it is kept whole. */
const CAP_TOLERANCE = 1.25;

const FENCE = /^\s*```/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const BOLD_MARK = "\u0001";

export function formatReply(text: string, format: ReplyFormat): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    // Code is shown as written: `a * b * c` is not emphasis.
    if (inFence) out.push(line);
    else if (!TABLE_SEPARATOR.test(line)) out.push(formatLine(line, format));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatLine(line: string, format: ReplyFormat): string {
  const heading = HEADING.exec(line);
  if (heading) {
    const title = inline(heading[1], "plain");
    return format === "whatsapp" ? `*${title}*` : title;
  }
  const row = TABLE_ROW.exec(line);
  if (row) {
    return row[1]
      .split("|")
      .map((cell) => inline(cell.trim(), format))
      .filter(Boolean)
      .join(" · ");
  }
  const unquoted = line.replace(/^\s*>\s?/, "");
  // A `*` bullet would otherwise read as the start of an italic.
  return inline(unquoted.replace(/^(\s*)[*+]\s+/, "$1- "), format);
}

function inline(text: string, format: ReplyFormat): string {
  // Inline code is left untouched inside; WhatsApp shows the backticks as code, the widget does not.
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return format === "whatsapp" ? part : part.slice(1, -1);
      return emphasis(links(part), format);
    })
    .join("");
}

function links(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
    label === url ? url : `${label}: ${url}`,
  );
}

/** Only delimiters that hug a word: `2*3`, `snake_case` and a lone `*` are not emphasis. */
function emphasis(text: string, format: ReplyFormat): string {
  const wa = format === "whatsapp";
  return text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD_MARK}$1${BOLD_MARK}`)
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, `${BOLD_MARK}$1${BOLD_MARK}`)
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, wa ? "_$1_" : "$1")
    .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, wa ? "_$1_" : "$1")
    .replaceAll(BOLD_MARK, wa ? "*" : "");
}

/**
 * Holds a reply to `max` characters: cut at the last sentence or paragraph that fits, else at a
 * word with an ellipsis. Never mid-word — a customer reads a cut word as a broken assistant.
 */
export function capReply(text: string, max: number | undefined): string {
  if (!max || text.length <= max * CAP_TOLERANCE) return text;
  const window = text.slice(0, max);
  let cut = -1;
  for (const m of window.matchAll(/[.!?…](?=\s|$)|\n\n/g)) {
    cut = m[0] === "\n\n" ? m.index : m.index + 1;
  }
  if (cut >= max * 0.5) return text.slice(0, cut).trimEnd();
  const space = window.lastIndexOf(" ", max - 1);
  return `${(space > 0 ? window.slice(0, space) : window.slice(0, max - 1)).trimEnd()}…`;
}
