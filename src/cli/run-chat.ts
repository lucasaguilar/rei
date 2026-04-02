import * as readline from "readline";
import * as path from "path";
import type { Agent } from "../core/agent.js";
import type { TurnStatus } from "../core/models/agent.types.js";
import type { ChatSession } from "../chat/types.js";

import { getWelcomeMessage, COMMANDS } from "./constants/chat.constants.js";
import {
  ActivePalette,
  CommandEntry,
  MentionEntry,
  ChatRendererState,
  ChatUIState,
  KeyboardActions,
} from "./models/chat.types.js";
import { clamp } from "./helpers/terminal.helpers.js";
import { buildMentionEntries } from "./helpers/chat.helpers.js";
import { ChatRenderer } from "./ui/chat-renderer.js";
import { KeyboardHandler } from "./ui/keyboard-handler.js";
import { InputHandler, InputHandlerContext } from "./ui/input-handler.js";
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
    // NOTE: Normalize Windows line endings to standard line feeds
    const normalized = value.replace(/\r\n/g, "\n");
    for (const line of normalized.split("\n")) {
      transcript.push(line);
    }
    if (transcript.length > 3000) {
      transcript.splice(0, transcript.length - 3000);
    }
  };

  const getCommandPalette = (): CommandEntry[] => {
    const trimmed = state.inputBuffer.trim().toLowerCase();
    if (!trimmed.startsWith("/") || state.busy || state.paletteClosed)
      return [];
    if (trimmed === "/") return COMMANDS;

    return COMMANDS.filter((entry) => entry.command.startsWith(trimmed));
  };

  const getMentionContext = ():
    | { start: number; end: number; query: string }
    | undefined => {
    if (state.busy || state.paletteClosed) return undefined;

    let start = state.inputCursor - 1;
    // NOTE: Walk backward until a whitespace character is found
    while (start >= 0 && !/\s/.test(state.inputBuffer[start])) {
      start -= 1;
    }
    start += 1;

    let end = state.inputCursor;
    // NOTE: Walk forward until a whitespace character is found
    while (
      end < state.inputBuffer.length &&
      !/\s/.test(state.inputBuffer[end])
    ) {
      end += 1;
    }

    const token = state.inputBuffer.slice(start, end);
    if (!token.startsWith("@")) return undefined;

    return {
      start,
      end,
      query: token.slice(1).toLowerCase(),
    };
  };

  const getMentionPalette = (): MentionEntry[] => {
    const context = getMentionContext();
    if (!context) return [];

    const query = context.query;
    const lowerQuery = query.toLowerCase();
    const scopedPrefix = lowerQuery.endsWith("/") ? lowerQuery : undefined;

    const items = mentionEntries.filter((entry) => {
      const valueLower = entry.value.toLowerCase();

      if (!lowerQuery) return true;

      if (scopedPrefix) {
        if (
          !valueLower.startsWith(scopedPrefix) ||
          valueLower === scopedPrefix
        ) {
          return false;
        }

        const remainder = valueLower.slice(scopedPrefix.length);
        const segments = remainder.split("/").filter(Boolean);
        return segments.length === 1;
      }

      return valueLower.includes(lowerQuery);
    });

    return items
      .sort((a, b) => {
        const aLower = a.value.toLowerCase();
        const bLower = b.value.toLowerCase();
        const aStarts = query ? aLower.startsWith(query) : false;
        const bStarts = query ? bLower.startsWith(query) : false;
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return aLower.localeCompare(bLower);
      })
      .slice(0, 100);
  };

  const getActivePalette = (): ActivePalette => {
    const mentionItems = getMentionPalette();
    if (mentionItems.length > 0) {
      return { kind: "mention", items: mentionItems };
    }

    const commandItems = getCommandPalette();
    if (commandItems.length > 0) {
      return { kind: "command", items: commandItems };
    }

    return { kind: "none", items: [] };
  };

  const findHistoryMatch = (
    query: string,
    startIndex?: number,
  ): number | undefined => {
    const q = query.trim().toLowerCase();
    if (!q) return undefined;

    let index = startIndex ?? state.inputHistory.length - 1;
    while (index >= 0) {
      if (state.inputHistory[index].toLowerCase().includes(q)) {
        return index;
      }
      index -= 1;
    }
    return undefined;
  };

  const clearHistorySearch = (restoreSnapshot: boolean): void => {
    if (restoreSnapshot) {
      state.inputBuffer = state.historySearchSnapshot.buffer;
      state.inputCursor = state.historySearchSnapshot.cursor;
    }
    state.historySearchMode = false;
    state.historySearchQuery = "";
    state.historySearchIndex = undefined;
  };

  const draw = (): void => {
    const renderState: ChatRendererState = {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      activePalette: getActivePalette(),
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
      getActivePalette,
      getMentionContext,
    },
  };

  const submitInput = async (): Promise<void> => {
    await InputHandler.submitInput(inputContext);
  };

  const kbActions: KeyboardActions = {
    draw,
    clearHistorySearch,
    findHistoryMatch,
    submitInput,
    getActivePalette,
    getMentionContext,
  };

  const onKeypress = (str: string, key: readline.Key): void => {
    KeyboardHandler.handleKeypress(str, key, state, kbActions);
  };

  const onResize = (): void => {
    draw();
  };

  const onMouseData = (chunk: Buffer): void => {
    const data = chunk.toString("utf8");
    if (!data.includes("\x1b[<") && !data.includes("\x1b[M")) return;

    state.suppressAnsiInputUntil = Date.now() + 250;

    // NOTE: Parse the SGR mouse data string to obtain action ID (e.g. 64/65 for wheel)
    const matches = data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g);
    let changed = false;

    for (const match of matches) {
      const code = Number(match[1]);
      if (Number.isNaN(code)) continue;

      if (code === 64) {
        state.scrollOffset += MOUSE_SCROLL_STEP;
        changed = true;
      } else if (code === 65) {
        state.scrollOffset = Math.max(
          0,
          state.scrollOffset - MOUSE_SCROLL_STEP,
        );
        changed = true;
      }
    }

    if (changed) {
      draw();
    }
  };

  process.stdin.on("keypress", onKeypress);
  process.stdin.on("data", onMouseData);
  process.stdout.on("resize", onResize);

  // NOTE: Enable mouse click (1000h) and SGR mouse reporting (1006h)
  // process.stdout.write("\x1b[?1000h\x1b[?1006h");
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
  // process.stdout.write("\x1b[?1000l\x1b[?1006l");
  // NOTE: Exit alternate screen buffer (1049l) and show cursor (?25h)
  process.stdout.write("\x1b[?1049l\x1b[?25h");
}
