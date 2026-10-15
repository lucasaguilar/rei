// Colour codes (CSI) and hyperlinks (OSC 8, closed by BEL or ST): both take no columns on screen.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

/**
 * Breaks each line of `text` so no row is wider than `width` columns, at spaces only.
 *
 * REI's answer reaches the screen as one long line per paragraph, and the terminal cut it at the
 * exact column — "Changed" came out as "Change" / "d". Escapes are carried along with the word
 * they touch and never counted, so a coloured span or a linked path moves to the next row whole.
 * A continuation row keeps the line's own indentation, so a list item still reads as one. A word
 * wider than the row is left alone: splitting it is the terminal's job, there is no better place.
 */
export function wrapWords(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => wrapLine(line, width))
    .join("\n");
}

function wrapLine(line: string, width: number): string {
  const indent = /^ */.exec(line)![0];
  const rows: string[] = [];
  let row = indent;
  let col = indent.length;
  let spaces = "";
  let word = "";
  let wordWidth = 0;

  const placeWord = (): void => {
    if (wordWidth > 0 && col > indent.length && col + spaces.length + wordWidth > width) {
      rows.push(row);
      row = indent + word;
      col = indent.length + wordWidth;
    } else {
      row += spaces + word;
      col += spaces.length + wordWidth;
    }
    spaces = "";
    word = "";
    wordWidth = 0;
  };

  for (let i = indent.length; i < line.length; ) {
    ESCAPE.lastIndex = i;
    const escape = ESCAPE.exec(line);
    if (escape) {
      word += escape[0];
      i += escape[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    i += ch.length;
    if (ch === " ") {
      if (word) placeWord();
      spaces += " ";
    } else {
      word += ch;
      wordWidth += 1;
    }
  }
  if (word) placeWord();
  rows.push(row);
  return rows.join("\n");
}
