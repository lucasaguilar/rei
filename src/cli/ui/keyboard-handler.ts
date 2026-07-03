import * as readline from "readline";
import { ChatUIState, KeyboardActions } from "../models/chat.types.js";
import {
  isMouseSgrSequence,
  looksLikeAnsiNoise,
  clamp,
  inputWrapWidth,
} from "../helpers/terminal.helpers.js";

export class KeyboardHandler {
  public static handleKeypress(
    str: string,
    key: readline.Key,
    state: ChatUIState,
    actions: KeyboardActions,
  ): void {
    if (!state.running) return;

    const keyWithSequence = key as readline.Key & { sequence?: string };
    const sequence = keyWithSequence.sequence ?? str;

    // ── Bracketed paste ────────────────────────────────────────────────────
    // The terminal brackets pasted text in \e[200~ … \e[201~, which Node emits
    // as 'paste-start'/'paste-end'. While inside a paste we keep newlines as
    // literal text (handled in the return branch below) instead of submitting,
    // so a multi-line paste lands as ONE message.
    if (key.name === "paste-start") {
      state.pasting = true;
      return;
    }
    if (key.name === "paste-end") {
      state.pasting = false;
      actions.draw();
      return;
    }

    // Ignore terminal mouse SGR sequences so they never leak into input text.
    if (isMouseSgrSequence(str, key)) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (state.historySearchMode) {
        actions.clearHistorySearch(true);
        actions.draw();
        return;
      }
      state.running = false;
      return;
    }

    if (key.ctrl && key.name === "r") {
      if (state.inputHistory.length === 0) {
        return;
      }

      if (!state.historySearchMode) {
        state.historySearchSnapshot = {
          buffer: state.inputBuffer,
          cursor: state.inputCursor,
        };
        state.historySearchMode = true;
        state.historySearchQuery = "";
        state.historySearchIndex = undefined;
      } else if (state.historySearchQuery.trim()) {
        const start =
          state.historySearchIndex !== undefined
            ? state.historySearchIndex - 1
            : state.inputHistory.length - 1;
        state.historySearchIndex = actions.findHistoryMatch(
          state.historySearchQuery,
          start,
        );
        if (state.historySearchIndex !== undefined) {
          state.inputBuffer = state.inputHistory[state.historySearchIndex];
          state.inputCursor = state.inputBuffer.length;
        }
      }

      actions.draw();
      return;
    }

    if (state.historySearchMode) {
      if (key.name === "return" || key.name === "enter") {
        actions.clearHistorySearch(false);
        actions.draw();
        return;
      }

      if (key.name === "escape") {
        actions.clearHistorySearch(true);
        actions.draw();
        return;
      }

      if (key.name === "backspace") {
        if (state.historySearchQuery.length > 0) {
          state.historySearchQuery = state.historySearchQuery.slice(0, -1);
          state.historySearchIndex = actions.findHistoryMatch(
            state.historySearchQuery,
          );
          if (state.historySearchIndex !== undefined) {
            state.inputBuffer = state.inputHistory[state.historySearchIndex];
            state.inputCursor = state.inputBuffer.length;
          } else if (!state.historySearchQuery) {
            state.inputBuffer = state.historySearchSnapshot.buffer;
            state.inputCursor = state.historySearchSnapshot.cursor;
          }
        }
        actions.draw();
        return;
      }

      if (str && !key.ctrl && !key.meta) {
        state.historySearchQuery += str;
        state.historySearchIndex = actions.findHistoryMatch(
          state.historySearchQuery,
        );
        if (state.historySearchIndex !== undefined) {
          state.inputBuffer = state.inputHistory[state.historySearchIndex];
          state.inputCursor = state.inputBuffer.length;
        }
        actions.draw();
      }

      return;
    }

    if (key.name === "return" || key.name === "enter") {
      // Inside a paste, a newline is literal text, not a submit.
      if (state.pasting) {
        state.inputBuffer = `${state.inputBuffer.slice(0, state.inputCursor)}\n${state.inputBuffer.slice(state.inputCursor)}`;
        state.inputCursor += 1;
        actions.draw();
        return;
      }
      void actions.submitCurrentUserInput();
      return;
    }

    if (state.busy) {
      return;
    }

    const activePalette = actions.getActivePalette();
    const palette = activePalette.items;

    if (key.name === "up") {
      // Multi-line input: move the cursor UP one visual row (keeping its column) before falling
      // back to history/palette. Only when editing a fresh buffer (not mid-history, no palette) and
      // the cursor isn't already on the first row.
      const upWidth = inputWrapWidth(state.sessionMode, state.cols);
      if (
        palette.length === 0 &&
        state.historyCursor === undefined &&
        state.inputCursor >= upWidth
      ) {
        state.inputCursor -= upWidth;
        actions.draw();
        return;
      }

      if (state.historyCursor !== undefined) {
        state.historyCursor = Math.max(0, state.historyCursor - 1);
        state.inputBuffer = state.inputHistory[state.historyCursor];
        state.inputCursor = state.inputBuffer.length;
        state.selectedCommandIndex = 0;
        state.paletteClosed = true;
        actions.draw();
        return;
      }

      if (palette.length > 0) {
        state.selectedCommandIndex = clamp(
          state.selectedCommandIndex - 1,
          0,
          palette.length - 1,
        );
        actions.draw();
        return;
      }

      if (state.inputHistory.length === 0) {
        return;
      }
      if (state.historyCursor === undefined) {
        state.historyDraft = state.inputBuffer;
        state.historyCursor = state.inputHistory.length - 1;
      } else {
        state.historyCursor = Math.max(0, state.historyCursor - 1);
      }
      state.inputBuffer = state.inputHistory[state.historyCursor];
      state.inputCursor = state.inputBuffer.length;
      state.selectedCommandIndex = 0;
      state.paletteClosed = true;
      actions.draw();
      return;
    }

    if (key.name === "down") {
      // Multi-line input: move the cursor DOWN one visual row before falling back to history/palette.
      const downWidth = inputWrapWidth(state.sessionMode, state.cols);
      const cursorRow = Math.floor(state.inputCursor / downWidth);
      const lastRow = Math.floor(state.inputBuffer.length / downWidth);
      if (
        palette.length === 0 &&
        state.historyCursor === undefined &&
        cursorRow < lastRow
      ) {
        state.inputCursor = Math.min(
          state.inputBuffer.length,
          state.inputCursor + downWidth,
        );
        actions.draw();
        return;
      }

      if (state.historyCursor !== undefined) {
        if (state.historyCursor < state.inputHistory.length - 1) {
          state.historyCursor += 1;
          state.inputBuffer = state.inputHistory[state.historyCursor];
        } else {
          state.historyCursor = undefined;
          state.inputBuffer = state.historyDraft;
          state.historyDraft = "";
        }
        state.inputCursor = state.inputBuffer.length;
        state.selectedCommandIndex = 0;
        state.paletteClosed = true;
        actions.draw();
        return;
      }

      if (palette.length > 0) {
        state.selectedCommandIndex = clamp(
          state.selectedCommandIndex + 1,
          0,
          palette.length - 1,
        );
        actions.draw();
        return;
      }

      actions.draw();
      return;
    }

    if (palette.length > 0 && key.name === "tab") {
      if (activePalette.kind === "mention") {
        const selected =
          activePalette.items[
            clamp(state.selectedCommandIndex, 0, activePalette.items.length - 1)
          ];
        const mentionContext = actions.getMentionContext();
        if (!mentionContext) {
          actions.draw();
          return;
        }
        const selectedText = `@${selected.value}`;
        const trailing = state.inputBuffer.slice(mentionContext.end);
        const needsSpace =
          !selected.isDir && (trailing.length === 0 || !/^\s/.test(trailing));
        const suffix = needsSpace ? " " : "";
        state.inputBuffer = `${state.inputBuffer.slice(0, mentionContext.start)}${selectedText}${suffix}${state.inputBuffer.slice(mentionContext.end)}`;
        state.inputCursor =
          mentionContext.start + selectedText.length + suffix.length;
        state.paletteClosed = !selected.isDir;
      } else {
        const selected =
          activePalette.items[
            clamp(state.selectedCommandIndex, 0, activePalette.items.length - 1)
          ];
        state.inputBuffer = selected.command;
        state.inputCursor = state.inputBuffer.length;
        state.paletteClosed = false;
      }
      state.selectedCommandIndex = 0;
      actions.draw();
      return;
    }

    if (key.name === "left") {
      state.inputCursor = Math.max(0, state.inputCursor - 1);
      state.historyCursor = undefined;
      state.historyDraft = "";
      actions.draw();
      return;
    }

    if (key.name === "right") {
      state.inputCursor = Math.min(
        state.inputBuffer.length,
        state.inputCursor + 1,
      );
      state.historyCursor = undefined;
      state.historyDraft = "";
      actions.draw();
      return;
    }

    if (key.name === "backspace") {
      if (state.inputCursor > 0) {
        state.inputBuffer = `${state.inputBuffer.slice(0, state.inputCursor - 1)}${state.inputBuffer.slice(state.inputCursor)}`;
        state.inputCursor -= 1;
        state.selectedCommandIndex = 0;
        state.paletteClosed = false;
        state.historyCursor = undefined;
        state.historyDraft = "";
      }
      actions.draw();
      return;
    }

    if (key.name === "delete") {
      if (state.inputCursor < state.inputBuffer.length) {
        state.inputBuffer = `${state.inputBuffer.slice(0, state.inputCursor)}${state.inputBuffer.slice(state.inputCursor + 1)}`;
        state.selectedCommandIndex = 0;
        state.paletteClosed = false;
        state.historyCursor = undefined;
        state.historyDraft = "";
      }
      actions.draw();
      return;
    }

    if (key.name === "escape") {
      state.selectedCommandIndex = 0;
      state.paletteClosed = true;
      actions.draw();
      return;
    }

    if (str && !key.ctrl && !key.meta) {
      state.inputBuffer = `${state.inputBuffer.slice(0, state.inputCursor)}${str}${state.inputBuffer.slice(state.inputCursor)}`;
      state.inputCursor += str.length;
      state.selectedCommandIndex = 0;
      state.paletteClosed = false;
      state.historyCursor = undefined;
      state.historyDraft = "";
      actions.draw();
    }
  }
}
