import * as readline from "readline";
import * as path from "path";
import type { Agent } from "../core/agent.js";
import type { TurnStatus } from "../core/models/agent.types.js";
import type { ChatSession } from "../chat/types.js";

import { getWelcomeMessage } from "./constants/chat.constants.js";
import {
  ChatRendererState,
  ChatUIState,
  KeyboardActions,
} from "./models/chat.types.js";
import { clamp } from "./helpers/terminal.helpers.js";
import { buildMentionEntries } from "./helpers/chat.helpers.js";
import {
  clearHistorySearchState,
  findHistoryMatch,
  getActivePalette,
  getMentionContext,
} from "./helpers/chat-input.helpers.js";
import { ChatRenderer } from "./ui/chat-renderer.js";
import { KeyboardHandler } from "./ui/keyboard-handler.js";
import { InputHandler } from "./ui/input-handler.js";
import type { InputHandlerContext } from "./models/input-handler.types.js";
import {
  startIndexingWorker,
  hasRagIndex,
} from "../context/rag/rag-indexer.js";
import {
  loadCurrentSession,
  saveSession,
  archiveCurrentSession,
} from "../chat/session-store.js";

export async function runChat(
  agent: Agent,
  workspacePath = process.cwd(),
  autoIndex = true,
): Promise<void> {
  const existing = loadCurrentSession(workspacePath);
  const session: ChatSession = existing
    ? {
        messages: existing.messages,
        mode: existing.mode,
        createdAt: existing.createdAt,
        summary: existing.summary,
      }
    : { messages: [], mode: "ask" };
  const mentionEntries = buildMentionEntries(workspacePath);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Error: The interactive chat UI requires both stdin and stdout to be TTYs. " +
        "Please run this command in an interactive terminal.",
    );
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  // Bracketed paste: the terminal wraps pasted text in \e[200~ … \e[201~, which
  // Node surfaces as 'paste-start'/'paste-end' keypress events. This lets us treat
  // newlines inside a paste as literal text instead of submitting on each one.
  process.stdout.write("\x1b[?2004h");

  let spinnerTimer: NodeJS.Timeout | undefined;
  const transcript: string[] = [];

  const state: ChatUIState = {
    running: true,
    busy: false,
    activeStatus: undefined,
    spinnerIndex: 0,

    historySearchMode: false,
    historySearchQuery: "",
    historySearchIndex: undefined,
    historySearchSnapshot: { buffer: "", cursor: 0 },

    inputBuffer: "",
    inputCursor: 0,
    inputHistory: [],
    historyCursor: undefined,
    historyDraft: "",
    pasting: false,

    selectedCommandIndex: 0,
    paletteClosed: false,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };

  const pushTranscript = (value: string, writeToStdout = true): void => {
    if (writeToStdout) {
      ChatRenderer.clearUI();
    }
    const normalized = value.replace(/\r\n/g, "\n");
    for (const line of normalized.split("\n")) {
      if (writeToStdout) {
        process.stdout.write(line + "\n");
      }
      transcript.push(line);
    }
    // We only keep transcript in memory for metrics, not for rendering
    if (transcript.length > 3000) {
      transcript.splice(0, transcript.length - 3000);
    }
  };

  const streamText = (value: string): void => {
    ChatRenderer.clearUI();
    process.stdout.write(value);
  };

  const getPalette = () => getActivePalette(state, mentionEntries);

  const findMatchingHistoryEntry = (
    query: string,
    startIndex?: number,
  ): number | undefined =>
    findHistoryMatch(state.inputHistory, query, startIndex);

  const clearHistorySearch = (restoreSnapshot: boolean): void => {
    clearHistorySearchState(state, restoreSnapshot);
  };

  const draw = (): void => {
    // Skip rendering if actively resizing to avoid overlapping visual frames
    if (resizeTimer !== undefined) return;

    const renderState: ChatRendererState = {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      activePalette: getPalette(),
      selectedCommandIndex: state.selectedCommandIndex,
      historySearchMode: state.historySearchMode,
      historySearchQuery: state.historySearchQuery,
      historySearchIndex: state.historySearchIndex,
      inputHistory: state.inputHistory,
      busy: state.busy,
      activeStatus: state.activeStatus,
      spinnerIndex: state.spinnerIndex,
      sessionMode: session.mode,
      inputBuffer: state.inputBuffer,
      inputCursor: state.inputCursor,
    };

    // selectedCommandIndex can be adjusted by draw
    const paletteItems = renderState.activePalette.items;
    state.selectedCommandIndex = clamp(
      state.selectedCommandIndex,
      0,
      Math.max(0, paletteItems.length - 1),
    );
    renderState.selectedCommandIndex = state.selectedCommandIndex;

    ChatRenderer.draw(renderState);
  };

  const stopSpinner = (): void => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  const startSpinner = (): void => {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      state.spinnerIndex += 1;
      draw();
    }, 100);
  };

  const resetInput = (): void => {
    clearHistorySearch(false);
    state.inputBuffer = "";
    state.inputCursor = 0;
    state.selectedCommandIndex = 0;
    state.paletteClosed = false;
    state.historyCursor = undefined;
    state.historyDraft = "";
  };

  const rememberHistory = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const last = state.inputHistory[state.inputHistory.length - 1];
    if (last !== value) {
      state.inputHistory.push(value);
    }
    if (state.inputHistory.length > 300) {
      state.inputHistory.splice(0, state.inputHistory.length - 300);
    }
    state.historyCursor = undefined;
    state.historyDraft = "";
  };

  const inputContext: InputHandlerContext = {
    state,
    agent,
    session,
    transcript,
    workspacePath,
    actions: {
      pushTranscript,
      streamText,
      draw,
      startSpinner,
      stopSpinner,
      resetInput,
      rememberHistory,
      getActivePalette: getPalette,
      getMentionContext: () => getMentionContext(state),
    },
  };

  // Bridge the Enter key handler to the full input-processing pipeline.
  const submitCurrentUserInput = async (): Promise<void> => {
    await InputHandler.submitInput(inputContext);
  };

  const kbActions: KeyboardActions = {
    draw,
    clearHistorySearch,
    findHistoryMatch: findMatchingHistoryEntry,
    submitCurrentUserInput,
    getActivePalette: getPalette,
    getMentionContext: () => getMentionContext(state),
  };

  const onKeypress = (str: string, key: readline.Key): void => {
    KeyboardHandler.handleKeypress(str, key, state, kbActions);
  };

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    // Clear UI immediately on the very first resize tick to prevent trailing layout artifacts
    if (resizeTimer === undefined) {
      ChatRenderer.clearUI(process.stdout.columns || 80);
    }

    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;

      // Clean the entire visible terminal viewport without pushing anything to scrollback
      process.stdout.write("\x1b[H\x1b[J");

      // Reset the drawn state in the renderer since we cleared the screen
      ChatRenderer.resetDrawnState();

      // Forzar a Node a actualizar las propiedades internas de filas y columnas
      state.cols = process.stdout.columns || 80;
      state.rows = process.stdout.rows || 24;

      // Reprint the entire transcript to the screen at the new terminal width
      for (const line of transcript) {
        process.stdout.write(line + "\n");
      }

      draw();
    }, 100); // 100ms le da un respiro más estable al buffer de la Mac
  };

  process.stdin.on("keypress", onKeypress);
  process.stdout.on("resize", onResize);

  if (existing) {
    const nonSystem = existing.messages.filter((m) => m.role !== "system");
    const turnCount = Math.floor(nonSystem.length / 2);
    pushTranscript(
      `[REI] Resuming session from ${new Date(existing.updatedAt).toLocaleString()} (${turnCount} turns).`,
    );
    if (existing.summary) {
      pushTranscript(`[REI] Summary: ${existing.summary}`);
    }
  } else {
    pushTranscript(getWelcomeMessage(session.mode));
  }

  if (autoIndex && !hasRagIndex(workspacePath)) {
    pushTranscript(
      "[RAG] First run detected — starting background indexing...",
    );
    startIndexingWorker(workspacePath, {
      onProgress: (indexed, total) => {
        pushTranscript(`[RAG] Indexing... ${indexed}/${total} files`);
        draw();
      },
      onDone: (message) => {
        pushTranscript(`[RAG] ${message}`);
        draw();
      },
    });
  }

  draw();

  while (state.running) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  stopSpinner();
  process.stdout.write("\x1b[?2004l"); // disable bracketed paste
  process.stdin.off("keypress", onKeypress);
  process.stdout.off("resize", onResize);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  ChatRenderer.clearUI();
  process.stdout.write("\x1b[?25h"); // Show cursor
}
