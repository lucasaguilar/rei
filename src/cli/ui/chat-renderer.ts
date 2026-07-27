import {
  ActivePalette,
  CommandEntry,
  MentionEntry,
  ChatRendererState,
} from "../models/chat.types.js";
import {
  MODE_PROMPTS,
  SPINNER_FRAMES,
  THINKING_TEXT,
  SHORTCUT_HINT,
} from "../constants/chat.constants.js";
import {
  clamp,
  padRight,
  fitLine,
  visibleLength,
  takeVisible,
} from "../helpers/terminal.helpers.js";
import { TurnStatus } from "../../core/models/agent.types.js";
import { SessionMode } from "../../chat/types.js";

/** Split text into fixed-width visual chunks, respecting ANSI escapes. */
function splitByVisibleWidth(text: string, width: number): string[] {
  if (!text || visibleLength(text) <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0 && visibleLength(remaining) > 0) {
    // takeVisible returns the longest prefix whose visual length ≤ width.
    const chunk = takeVisible(remaining, width);
    if (!chunk || visibleLength(chunk) === 0) break;
    lines.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return lines;
}

export class ChatRenderer {
  private static lastDrawnLinesCount = 0;
  private static lastDrawnCols = 0;
  private static lastDrawnLines: string[] = [];
  /** Rows the terminal cursor was parked ABOVE the bottom of the last draw (multi-line input). */
  private static lastCursorRowsFromBottom = 0;

  public static resetDrawnState(): void {
    this.lastDrawnLinesCount = 0;
    this.lastDrawnCols = 0;
    this.lastDrawnLines = [];
  }

  // Dentro de tu ChatRenderer o helper de limpieza:
  public static hardResetTerminal() {
    // \x1bc limpia la pantalla, \x1b[3J limpia el scrollback buffer de la terminal
    process.stdout.write("\x1bc\x1b[3J");
  }

  public static clearUI(newCols?: number): void {
    if (this.lastDrawnLinesCount <= 0) return;

    process.stdout.write("\x1b[?25l"); // Hide cursor

    // The previous draw may have parked the cursor in the MIDDLE of a multi-line input (we move it
    // up to the input's cursor row). clearUI erases upward from the current line, so we must first
    // drop back down to the bottom of the drawn block — otherwise the rows below the cursor are
    // never cleared and ghost (the repeated-line garbage you can get on a wrapped/pasted prompt).
    if (this.lastCursorRowsFromBottom > 0) {
      process.stdout.write(`\x1b[${this.lastCursorRowsFromBottom}B`);
      this.lastCursorRowsFromBottom = 0;
    }

    let reflowedRows = this.lastDrawnLinesCount;
    if (newCols && newCols !== this.lastDrawnCols && this.lastDrawnLines.length > 0) {
      reflowedRows = 0;
      for (const line of this.lastDrawnLines) {
        const len = visibleLength(line);
        reflowedRows += Math.max(1, Math.ceil(len / newCols));
      }
    }

    // Clear each UI line individually, from bottom to top,
    // so we never touch anything above the UI area.
    for (let i = 0; i < reflowedRows; i++) {
      if (i > 0) {
        process.stdout.write("\x1b[1A"); // Move up one line
      }
      process.stdout.write("\x1b[2K"); // Clear the entire line
    }
    process.stdout.write("\x1b[1G"); // Move to column 1
    process.stdout.write("\x1b[?25h"); // Show cursor

    this.lastDrawnLinesCount = 0;
    this.lastDrawnLines = [];
  }

  public static draw(state: ChatRendererState): void {
    const currentCols = Math.max(40, state.cols - 1);
    const currentRows = Math.max(12, state.rows);

    const cols = currentCols;
    const rows = currentRows;
    const activePalette = state.activePalette;
    const paletteItems = activePalette.items;
    const paletteVisible = paletteItems.length > 0;

    const selectedCommandIndex = clamp(
      state.selectedCommandIndex,
      0,
      Math.max(0, paletteItems.length - 1),
    );

    const maxPaletteItems = Math.min(5, paletteItems.length);

    const statusLine = state.historySearchMode
      ? (() => {
          const head = `(reverse-i-search)\`${state.historySearchQuery}\`: `;
          if (state.historySearchIndex === undefined) {
            return `${head}no match`;
          }
          return `${head}${state.inputHistory[state.historySearchIndex]}`;
        })()
      : state.activeStatus || state.activeStatusText
        ? `\x1b[1;36m[REI] ${SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length]} ${
            state.activeStatusText ?? THINKING_TEXT[state.activeStatus as TurnStatus] ?? state.activeStatus
          }\x1b[0m`
        : SHORTCUT_HINT;

    const uiLines: string[] = [];

    if (statusLine) {
      uiLines.push(padRight(fitLine(statusLine, cols), cols));
    }

    if (paletteVisible) {
      const innerWidth = Math.max(1, cols - 4);
      const listStart = Math.max(
        0,
        Math.min(
          selectedCommandIndex - maxPaletteItems + 1,
          paletteItems.length - maxPaletteItems,
        ),
      );
      const visibleItems = paletteItems.slice(
        listStart,
        listStart + maxPaletteItems,
      );
      uiLines.push(`+${"-".repeat(cols - 2)}+`);
      for (let i = 0; i < visibleItems.length; i += 1) {
        const entry = visibleItems[i];
        const absoluteIndex = listStart + i;
        const marker = absoluteIndex === selectedCommandIndex ? ">" : " ";
        let text: string;
        if (activePalette.kind === "mention") {
          const mentionEntry = entry as MentionEntry;
          text = `${marker} @${mentionEntry.value} - ${mentionEntry.description}`;
        } else {
          const commandEntry = entry as CommandEntry;
          text = `${marker} ${commandEntry.command} - ${commandEntry.description}`;
        }
        uiLines.push(`| ${padRight(fitLine(text, innerWidth), innerWidth)} |`);
      }
      uiLines.push(`+${"-".repeat(cols - 2)}+`);
    }

    const rawPrompt = MODE_PROMPTS[state.sessionMode as SessionMode];
    const promptColor =
      state.sessionMode === "ask"
        ? "\x1b[1;32m"      // Bold Green
        : state.sessionMode === "planning"
          ? "\x1b[1;33m"    // Bold Yellow
          : "\x1b[1;35m";   // Bold Magenta/Purple
    const promptText = `${promptColor}${rawPrompt}\x1b[0m`;
    const promptLen = visibleLength(promptText);

    const inputInnerWidth = Math.max(1, cols - promptLen - 1);

    this.clearUI(currentCols);
    this.lastDrawnCols = currentCols;

    // Render newlines (from a multi-line paste) as a dim ↵ glyph inline. Each is one visible
    // column, so the whole input is a flat sequence of columns for wrapping + cursor math.
    const visibleInput = state.inputBuffer.replace(/\n/g, "\x1b[90m↵\x1b[0m");

    // Wrap the input into visual rows of inputInnerWidth. THIS is the feature: a line that reaches
    // the right edge continues on the row below as you type, instead of scrolling horizontally.
    const allWrapped = splitByVisibleWidth(visibleInput, inputInnerWidth);

    // Cursor 2D position — every raw buffer char (incl. \n→↵) occupies exactly one visible column,
    // so the cursor's visible position equals its raw index and wrapping is a pure width divide.
    const cursorRow = Math.floor(state.inputCursor / inputInnerWidth);
    const cursorCol = state.inputCursor % inputInnerWidth;

    // Vertical cap: keep the input box bounded. Show at most MAX_INPUT_ROWS rows as a window that
    // always keeps the cursor's row visible, so a very long / pasted prompt stays usable.
    const MAX_INPUT_ROWS = 8;
    const winStart =
      allWrapped.length > MAX_INPUT_ROWS
        ? clamp(cursorRow - (MAX_INPUT_ROWS - 1), 0, allWrapped.length - MAX_INPUT_ROWS)
        : 0;
    const wrappedLines = allWrapped.slice(winStart, winStart + MAX_INPUT_ROWS);
    const cursorRowInWindow = cursorRow - winStart;

    // Active-document indicator: a dim 📄 line right above the prompt. It's part of uiLines (so the
    // tracked line count + clearUI stay correct) and sits ABOVE the input rows, leaving the cursor
    // math below untouched.
    if (state.activeDocument) {
      const docName = state.activeDocument.split("/").pop() ?? state.activeDocument;
      uiLines.push(`\x1b[2m📄 ${docName}\x1b[0m`);
    }

    // First input row carries the prompt; continuation rows are padded so text stays aligned.
    uiLines.push(`${promptText}${wrappedLines[0] ?? ""}`);
    for (let i = 1; i < wrappedLines.length; i++) {
      uiLines.push(`${" ".repeat(promptLen)}${wrappedLines[i]}`);
    }

    process.stdout.write("\x1b[?25l"); // hide cursor while drawing
    process.stdout.write(uiLines.join("\r\n"));
    this.lastDrawnLinesCount = uiLines.length; // clearUI erases exactly this many rows next draw
    this.lastDrawnLines = uiLines;

    // The terminal cursor now sits at the end of the last drawn row. Move it UP to the cursor's
    // input row, then to its absolute column (prompt on row 0 and padding on the rest both offset
    // the input text by promptLen columns).
    const rowsUp = wrappedLines.length - 1 - cursorRowInWindow;
    if (rowsUp > 0) process.stdout.write(`\x1b[${rowsUp}A`);
    const cursorColumn = promptLen + cursorCol + 1; // 1-based terminal column
    process.stdout.write(`\x1b[${cursorColumn}G\x1b[?25h`);
    // Remember how far above the bottom the cursor is parked, so the NEXT clearUI drops back down
    // to the bottom before erasing (otherwise the rows below the cursor ghost).
    this.lastCursorRowsFromBottom = rowsUp;
  }
}
