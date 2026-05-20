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
  visibleLength,
} from "../helpers/terminal.helpers.js";
import { TurnStatus } from "../../core/models/agent.types.js";
import { SessionMode } from "../../chat/types.js";

export class ChatRenderer {
  private static lastDrawnLinesCount = 0;
  private static lastDrawnCols = 0;
  private static lastDrawnLines: string[] = [];

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

    let reflowedRows = this.lastDrawnLinesCount;
    if (newCols && newCols !== this.lastDrawnCols && this.lastDrawnLines.length > 0) {
      reflowedRows = 0;
      for (const line of this.lastDrawnLines) {
        const len = visibleLength(line);
        reflowedRows += Math.max(1, Math.ceil(len / newCols));
      }
    }

    const moveUp = reflowedRows - 1;
    if (moveUp > 0) {
      process.stdout.write(`\x1b[${moveUp}A`);
    }

    process.stdout.write("\x1b[J"); // Clear to end of screen
    process.stdout.write("\x1b[1G"); // Move to column 1
    process.stdout.write("\x1b[?25h"); // Show cursor

    this.lastDrawnLinesCount = 0;
    this.lastDrawnLines = [];
  }

  public static draw(state: ChatRendererState): void {
    const currentCols = Math.max(40, state.cols - 1);
    const currentRows = Math.max(12, state.rows);

    this.clearUI(currentCols);
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
    const viewport = viewportForInput(
      state.inputBuffer,
      state.inputCursor,
      inputInnerWidth,
    );
    const cursorInViewport = clamp(
      state.inputCursor - viewport.start,
      0,
      Math.max(0, viewport.visible.length),
    );

    uiLines.push(`${promptText}${viewport.visible}`);

    process.stdout.write("\x1b[?25l");
    process.stdout.write(uiLines.join("\r\n"));
    this.lastDrawnLinesCount = uiLines.length;
    this.lastDrawnLines = uiLines;

    const inputColumn = promptLen + 1 + cursorInViewport;
    process.stdout.write(`\x1b[${inputColumn}G\x1b[?25h`);
  }
}
