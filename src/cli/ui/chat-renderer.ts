import wrapAnsi from "wrap-ansi";
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
  viewportForInput,
} from "../helpers/terminal.helpers.js";
import { TurnStatus } from "../../core/models/agent.types.js";
import { SessionMode } from "../../chat/types.js";

export class ChatRenderer {
  private static lastDrawnLinesCount = 0;
  private static lastDrawnCols = 0;

  public static clearUI(): void {
    if (this.lastDrawnLinesCount <= 0) return;

    process.stdout.write("\x1b[?25l"); // Hide cursor
    process.stdout.write("\x1b[1B"); // Move down 1 line from input to bottom border

    for (let i = 0; i < this.lastDrawnLinesCount; i++) {
      process.stdout.write("\x1b[2K"); // Clear line
      if (i < this.lastDrawnLinesCount - 1) {
        process.stdout.write("\x1b[1A"); // Move up
      }
    }

    process.stdout.write("\x1b[1G"); // Move to column 1
    process.stdout.write("\x1b[?25h"); // Show cursor

    this.lastDrawnLinesCount = 0;
  }

  public static draw(state: ChatRendererState): void {
    const currentCols = Math.max(40, state.cols - 1);
    const currentRows = Math.max(12, state.rows);

    if (
      this.lastDrawnCols !== 0 &&
      this.lastDrawnCols !== currentCols &&
      this.lastDrawnLinesCount > 0
    ) {
      // Terminal was resized: relative cursor arithmetic in clearUI() is now
      // invalid because old lines may have visually reflowed at the new width.
      // Use absolute positioning to clear: jump to the last terminal row (known
      // position regardless of reflow), move up past the old UI, clear to end.
      process.stdout.write(`\x1b[${currentRows};1H`); // absolute: last row, col 1
      process.stdout.write(`\x1b[${this.lastDrawnLinesCount + 2}A`); // up past old UI
      process.stdout.write("\x1b[J"); // clear from here to end of screen
      this.lastDrawnLinesCount = 0;
    } else {
      this.clearUI();
    }
    this.lastDrawnCols = currentCols;

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
      : state.busy && state.activeStatus
        ? `[REI] Thinking ${SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length]} ${
            THINKING_TEXT[state.activeStatus as TurnStatus]
          }`
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

    const promptText = MODE_PROMPTS[state.sessionMode as SessionMode];
    const fullInput = `${promptText}${state.inputBuffer}`;
    const inputInnerWidth = Math.max(1, cols - 4);
    const inputAbsoluteCursor = promptText.length + state.inputCursor;
    const viewport = viewportForInput(
      fullInput,
      inputAbsoluteCursor,
      inputInnerWidth,
    );
    const cursorInViewport = clamp(
      inputAbsoluteCursor - viewport.start,
      0,
      Math.max(0, viewport.visible.length),
    );

    uiLines.push(`-${"-".repeat(cols - 2)}-`);
    uiLines.push(`| ${padRight(viewport.visible, inputInnerWidth)} |`);
    uiLines.push(`-${"-".repeat(cols - 2)}-`);

    process.stdout.write("\x1b[?25l");
    process.stdout.write(uiLines.join("\r\n"));
    this.lastDrawnLinesCount = uiLines.length;

    const inputColumn = 3 + cursorInViewport;
    process.stdout.write(`\x1b[1A\x1b[${inputColumn}G\x1b[?25h`);
  }
}
