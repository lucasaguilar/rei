import * as readline from "readline";
import * as path from "path";
import type { Agent } from "../core/agent.js";
import type { TurnStatus } from "../core/models/agent.types.js";
import { resolveDefaultSessionMode, type ChatSession } from "../chat/types.js";

import { getWelcomeMessage } from "./constants/chat.constants.js";
import { renderStartupGauge } from "./helpers/startup-gauge.helper.js";
import {
  ChatRendererState,
  ChatUIState,
  KeyboardActions,
} from "./models/chat.types.js";
import { clamp } from "./helpers/terminal.helpers.js";
import {
  buildMentionEntries,
  displayUserLabel,
} from "./helpers/chat.helpers.js";
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
import { CliElicitation } from "./cli-elicitation.js";
import {
  startIndexingWorker,
  hasRagIndex,
} from "../context/rag/rag-indexer.js";
import { isRagEnabled } from "../context/rag/rag-enabled.js";
import {
  resolveStartupSession,
  mostRecentSessionId,
  getActiveSessionId,
} from "../chat/session-store.js";
import { acquireOrWarn, releaseSessionLock } from "../chat/session-lock.js";

export async function runChat(
  agent: Agent,
  workspacePath = process.cwd(),
  autoIndex = true,
  sessionOpts?: { name?: string; continue?: boolean; force?: boolean },
): Promise<void> {
  const existing = resolveStartupSession(workspacePath, sessionOpts);
  const sessionId = getActiveSessionId();
  // Refuse to open a session already live in another terminal (avoids last-write-wins corruption).
  if (!acquireOrWarn(workspacePath, sessionId, sessionOpts?.force)) return;
  const session: ChatSession = existing
    ? {
        messages: existing.messages,
        mode: existing.mode,
        createdAt: existing.createdAt,
        summary: existing.summary,
      }
    : { messages: [], mode: resolveDefaultSessionMode() };
  // Rebuilt after every turn (submitCurrentUserInput): a turn can CREATE files (OCR sidecar writes
  // ocr/*.ocr.md) that must be @-referenceable this session. `let` so getPalette reads the freshest scan.
  let mentionEntries = buildMentionEntries(workspacePath);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Error: The interactive chat UI requires both stdin and stdout to be TTYs. " +
        "Please run this command in an interactive terminal.",
    );
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  // Bracketed paste: the terminal wraps pasted text in \e[200~ … \e[201~ (Node emits
  // 'paste-start'/'paste-end'), so newlines inside a paste stay literal instead of submitting.
  process.stdout.write("\x1b[?2004h");

  let spinnerTimer: NodeJS.Timeout | undefined;
  const transcript: string[] = [];

  const uiState: ChatUIState = {
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
    sessionMode: session.mode,
    activeDocument: session.activeDocument,
  };

  let exitResolve!: () => void;
  const shutdownPromise = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  // Shutdown interceptor: setting `state.running = false` (/exit, Ctrl+C) triggers the Proxy trap,
  // which resolves the shutdown promise and kicks off the cleanup → process.exit flow.
  const state: ChatUIState = new Proxy(uiState, {
    set(target, prop, value) {
      if (prop === "running" && value === false) {
        exitResolve();
      }
      return Reflect.set(target, prop, value);
    },
  });

  // pushTranscript: adds a line to the transcript and writes it to stdout.
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
    if (transcript.length > 3000) {
      transcript.splice(0, transcript.length - 3000);
    }
  };

  // streamText: writes a string straight to process.stdout.
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
    // Skip rendering if shutting down — /exit writes "Goodbye!"; a late draw() would ghost it.
    if (!state.running) return;
    // Skip rendering if actively resizing to avoid overlapping visual frames
    if (resizeTimer !== undefined) return;

    // Keep keyboard mode + active document current (Up/Down prompt width, doc indicator).
    state.sessionMode = session.mode;
    state.activeDocument = session.activeDocument;

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
      activeStatusText: state.activeStatusText,
      statusStartedAt: state.statusStartedAt,
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
      modelLabel: state.modelLabel,
      spinnerIndex: state.spinnerIndex,
      sessionMode: session.mode,
      inputBuffer: state.inputBuffer,
      inputCursor: state.inputCursor,
      activeDocument: session.activeDocument,
    };

    const paletteItems = renderState.activePalette.items; // selectedCommandIndex adjusted by draw
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

  // Transcript-based elicitation (ask_user): the model asks mid-turn, the turn pauses so the user
  // answers through REI's own input, then resumes. See docs/intent-router-spec.md.
  const cliElicit = new CliElicitation({
    pushTranscript,
    setBusy: (busy) => {
      state.busy = busy;
    },
    stopSpinner,
    draw,
  });

  const inputContext: InputHandlerContext = {
    state,
    agent,
    session,
    transcript,
    workspacePath,
    elicit: cliElicit.elicit,
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
    // If awaiting an ask_user answer, the next line answers IT: echo, clear, resume. See CliElicitation.
    if (cliElicit.isPending) {
      const answer = state.inputBuffer;
      pushTranscript(displayUserLabel(answer.trim()));
      resetInput();
      cliElicit.deliver(answer);
      return;
    }
    await InputHandler.submitInput(inputContext);
    // Pick up any files the turn just created (OCR output, generated files) so `@` finds them now.
    mentionEntries = buildMentionEntries(workspacePath);
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
  process.stdin.on("close", () => exitResolve());

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
    // Multi-session: this is a fresh session — tell the user how to recover the previous one.
    const recent = mostRecentSessionId(workspacePath);
    if (recent) {
      pushTranscript(
        `\x1b[90m[REI] Nueva sesión. Usá 'rei -c' para continuar la última (${recent}), o 'rei --session <nombre>' para una con nombre.\x1b[0m`,
      );
    }
  }

  // Show the context gauge on startup too (not only after the first turn), so the user sees
  // how full the assumed window already is from the resumed session / system prompt + the
  // function-calling tools array (built-in + MCP schemas), which isn't in the history.
  const startupGauge = renderStartupGauge(agent, session, workspacePath);
  if (startupGauge.line) pushTranscript(startupGauge.line);
  state.contextTokens = startupGauge.tokens;
  state.contextWindow = startupGauge.window;
  state.modelLabel = startupGauge.model;

  if (autoIndex && isRagEnabled() && !hasRagIndex(workspacePath)) {
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

  // Wait for the chat loop to end: `/exit`, Ctrl+C, or stdin close.
  // The Proxy on `state` resolves this promise when `running` becomes false.
  await shutdownPromise;

  releaseSessionLock(workspacePath, sessionId); // free the session for other terminals
  stopSpinner();
  process.stdout.write("\x1b[?2004l"); // disable bracketed paste
  process.stdin.off("keypress", onKeypress);
  process.stdout.off("resize", onResize);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  // Erase the ghost prompt line(s) the renderer left behind, then exit.
  ChatRenderer.clearUI();
  process.stdout.write("\x1b[?25h"); // Show cursor
  process.exit(0);
}
