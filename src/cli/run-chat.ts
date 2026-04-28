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
import {
  appendTranscriptLines,
  applyMouseWheelScroll,
} from "./helpers/chat-runtime.helpers.js";
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

  let spinnerTimer: NodeJS.Timeout | undefined;
  const transcript: string[] = [];
  const MOUSE_SCROLL_STEP = 3;

  const state: ChatUIState = {
    running: true,
    busy: false,
    activeStatus: undefined,
    spinnerIndex: 0,
    suppressAnsiInputUntil: 0,

    historySearchMode: false,
    historySearchQuery: "",
    historySearchIndex: undefined,
    historySearchSnapshot: { buffer: "", cursor: 0 },

    inputBuffer: "",
    inputCursor: 0,
    inputHistory: [],
    historyCursor: undefined,
    historyDraft: "",

    selectedCommandIndex: 0,
    paletteClosed: false,
    scrollOffset: 0,
  };

  const pushTranscript = (value: string): void => {
    appendTranscriptLines(transcript, value);
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
      scrollOffset: state.scrollOffset,
      transcript,
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
    state.scrollOffset = 0; // snap to bottom on submit
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

  const onResize = (): void => {
    draw();
  };

  const onMouseData = (chunk: Buffer): void => {
    const data = chunk.toString("utf8");
    const changed = applyMouseWheelScroll(data, state, MOUSE_SCROLL_STEP);
    if (!changed) return;

    state.suppressAnsiInputUntil = Date.now() + 250;
    draw();
  };

  process.stdin.on("keypress", onKeypress);
  process.stdin.on("data", onMouseData);
  process.stdout.on("resize", onResize);

  // NOTE: Enable mouse click (1000h) and SGR mouse reporting (1006h)
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
  // NOTE: Enter alternate screen buffer (1049h)
  process.stdout.write("\x1b[?1049h");

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
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  stopSpinner();
  process.stdin.off("keypress", onKeypress);
  process.stdin.off("data", onMouseData);
  process.stdout.off("resize", onResize);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  // NOTE: Disable mouse click (1000l) and SGR mouse reporting (1006l)
  process.stdout.write("\x1b[?1000l\x1b[?1006l");
  // NOTE: Exit alternate screen buffer (1049l) and show cursor (?25h)
  process.stdout.write("\x1b[?1049l\x1b[?25h");
}
