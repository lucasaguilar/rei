import wrapAnsi from "wrap-ansi";
import { ActivePalette, CommandEntry, MentionEntry, ChatRendererState } from "../models/chat.types.js";
import { MODE_PROMPTS, SPINNER_FRAMES, THINKING_TEXT, SHORTCUT_HINT } from "../constants/chat.constants.js";
import { clamp, padRight, fitLine, viewportForInput } from "../helpers/terminal.helpers.js";
import { TurnStatus } from "../../core/agent.js";
import { SessionMode } from "../../chat/types.js";

export class ChatRenderer {
  public static draw(state: ChatRendererState): void {
    const cols = Math.max(40, state.cols - 1);
    const rows = Math.max(12, state.rows);
    const activePalette = state.activePalette;
    const paletteItems = activePalette.items;
    const paletteVisible = paletteItems.length > 0;

    const selectedCommandIndex = clamp(state.selectedCommandIndex, 0, Math.max(0, paletteItems.length - 1));

    const inputHeight = 3;
    const maxPaletteItems = Math.min(5, paletteItems.length);
    const paletteHeight = paletteVisible ? maxPaletteItems + 2 : 0;
    const outputHeight = Math.max(1, rows - inputHeight - paletteHeight);

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
      : state.scrollOffset > 0
      ? `↑ Scrolled up ${state.scrollOffset} lines — Ctrl+D to scroll down`
      : SHORTCUT_HINT;

    const messageSlots = statusLine ? outputHeight - 1 : outputHeight;
    const wrappedTranscriptLines = state.transcript.flatMap((line) =>
      wrapAnsi(line, cols, { hard: true, trim: false, wordWrap: true }).split("\n")
    );
    const totalWrapped = wrappedTranscriptLines.length;
    const maxScrollOffset = Math.max(0, totalWrapped - messageSlots);
    const effectiveOffset = Math.min(state.scrollOffset, maxScrollOffset);
    const endIdx = totalWrapped - effectiveOffset;
    const startIdx = Math.max(0, endIdx - messageSlots);
    const outputLines = wrappedTranscriptLines.slice(startIdx, endIdx);

    const screen: string[] = [];
    const remaining = Math.max(0, messageSlots - outputLines.length);
    for (let i = 0; i < remaining; i += 1) {
      screen.push(" ".repeat(cols));
    }
    for (const line of outputLines) {
      screen.push(padRight(fitLine(line, cols), cols));
    }
    if (statusLine) {
      screen.push(padRight(fitLine(statusLine, cols), cols));
    }

    if (paletteVisible) {
      const innerWidth = Math.max(1, cols - 4);
      const listStart = Math.max(
        0,
        Math.min(selectedCommandIndex - maxPaletteItems + 1, paletteItems.length - maxPaletteItems)
      );
      const visibleItems = paletteItems.slice(listStart, listStart + maxPaletteItems);
      screen.push(`+${"-".repeat(cols - 2)}+`);
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
        screen.push(`| ${padRight(fitLine(text, innerWidth), innerWidth)} |`);
      }
      screen.push(`+${"-".repeat(cols - 2)}+`);
    }

    const promptText = MODE_PROMPTS[state.sessionMode as SessionMode];
    const fullInput = `${promptText}${state.inputBuffer}`;
    const inputInnerWidth = Math.max(1, cols - 4);
    const inputAbsoluteCursor = promptText.length + state.inputCursor;
    const viewport = viewportForInput(fullInput, inputAbsoluteCursor, inputInnerWidth);
    const cursorInViewport = clamp(inputAbsoluteCursor - viewport.start, 0, Math.max(0, viewport.visible.length));

    screen.push(`-${"-".repeat(cols - 2)}-`);
    screen.push(`| ${padRight(viewport.visible, inputInnerWidth)} |`);
    screen.push(`-${"-".repeat(cols - 2)}-`);

    while (screen.length < rows) {
      screen.unshift(" ".repeat(cols));
    }
    if (screen.length > rows) {
      screen.splice(0, screen.length - rows);
    }

    // NOTE: Hide cursor (?25l), move to home (H), and clear screen (2J)
    process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
    process.stdout.write(screen.join("\r\n"));

    const inputLineRow = rows - 1;
    const inputColumn = 3 + cursorInViewport;
    // NOTE: Move cursor to input position (row;colH) and show cursor (?25h)
    process.stdout.write(`\x1b[${inputLineRow};${inputColumn}H\x1b[?25h`);
  }
}
