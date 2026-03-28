import * as readline from "readline";
import * as path from "path";
import wrapAnsi from "wrap-ansi";
import type { Agent, TurnStatus } from "../core/agent.js";
import type { ChatSession, SessionMode } from "../chat/types.js";
import { REI_LOGO } from "./rei-logo.js";
import { renderMarkdown } from "./markdown-renderer.js";
import { formatPatchForTerminal } from "../tools/patch-generator.js";
import { scanWorkspace } from "../workspace/workspace-scanner.js";

const getWelcomeMessage = (mode: SessionMode): string => {

  return `${REI_LOGO}
REI — Repository-Aware AI Agent

Mode: ${mode}
Commands:
  /mode ask
  /mode planning
  /mode agent
  /pending
  /confirm
  /confirm --dry-run
  /discard
  /exit

Ready.`;
};

const HELP_TEXT = `Commands:
  /exit           - end the session
  /clear          - clear conversation history
  /help           - show this help
  /mode ask       - switch to ask mode
  /mode planning  - switch to planning mode
  /mode agent     - switch to agent mode
  /pending        - show currently queued validated patches
  /confirm        - apply queued patches
  /confirm --dry-run - validate/apply-check queued patches only
  /discard        - clear queued patches without applying`;

const MODE_PROMPTS: Record<SessionMode, string> = {
  ask: "ask > ",
  planning: "plan > ",
  agent: "agent > ",
};

const THINKING_TEXT: Record<TurnStatus, string> = {
  building_context: "Building context...",
  calling_model: "Calling model...",
  producing_response: "Producing response...",
};

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const SHORTCUT_HINT = "Shortcuts: Up/Down history | Ctrl+U/D scroll | / commands | @ files | Tab complete | Esc close | Ctrl+R search";

const COMMANDS: Array<{ command: string; description: string; requiresArgs?: boolean }> = [
  { command: "/exit", description: "end the session" },
  { command: "/clear", description: "clear conversation history" },
  { command: "/help", description: "show available commands" },
  { command: "/mode ask", description: "switch to ask mode" },
  { command: "/mode planning", description: "switch to planning mode" },
  { command: "/mode agent", description: "switch to agent mode" },
  { command: "/pending", description: "show queued patches" },
  { command: "/confirm", description: "apply queued patches" },
  { command: "/confirm --dry-run", description: "validate queued patches only" },
  { command: "/discard", description: "clear queued patches" },
];

type MentionEntry = {
  value: string;
  description: string;
  isDir: boolean;
};

type CommandEntry = { command: string; description: string; requiresArgs?: boolean };

type ActivePalette =
  | {
    kind: "command";
    items: CommandEntry[];
  }
  | {
    kind: "mention";
    items: MentionEntry[];
  }
  | {
    kind: "none";
    items: [];
  };

const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function takeVisible(value: string, width: number): string {
  if (width <= 0) return "";

  let out = "";
  let visible = 0;

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\u001b") {
      const rest = value.slice(i);
      const match = /^\x1B\[[0-?]*[ -/]*[@-~]/.exec(rest);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    if (visible >= width) {
      break;
    }

    out += value[i];
    visible += 1;
  }

  return out;
}

function fitLine(value: string, width: number): string {
  // Return an empty string if the width is non-positive
  if (width <= 0) return "";

  // If the visible length of the value is less than or equal to the width, return the value as is
  if (visibleLength(value) <= width) return value;

  // If the width is 1, return a single dot
  if (width === 1) return ".";

  // Otherwise, truncate the value to fit the width and append a dot
  return `${takeVisible(value, width - 1)}.`;
}

function padRight(value: string, width: number): string {
  const len = visibleLength(value);
  if (len >= width) return value;
  return value + " ".repeat(width - len);
}

function viewportForInput(text: string, cursor: number, width: number): { visible: string; start: number } {
  if (width <= 0) {
    return { visible: "", start: 0 };
  }

  if (text.length <= width) {
    return { visible: text, start: 0 };
  }

  const start = Math.min(Math.max(0, cursor - width + 1), text.length - width);
  return {
    visible: text.slice(start, start + width),
    start,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function buildMentionEntries(workspacePath: string): MentionEntry[] {
  const files = scanWorkspace(workspacePath);
  const fileSet = new Set<string>();
  const dirSet = new Set<string>();

  for (const file of files) {
    const filePath = toPosixPath(file.path);
    fileSet.add(filePath);

    let currentDir = path.posix.dirname(filePath);
    while (currentDir && currentDir !== ".") {
      dirSet.add(`${currentDir}/`);
      const parent = path.posix.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  }

  const dirs = Array.from(dirSet)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, description: "folder", isDir: true }));

  const regularFiles = Array.from(fileSet)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, description: "file", isDir: false }));

  return [...dirs, ...regularFiles];
}

export async function runChat(agent: Agent, workspacePath = process.cwd()): Promise<void> {
  const session: ChatSession = { messages: [], mode: "ask" };
  const mentionEntries = buildMentionEntries(workspacePath);

  // Ensure we only start the full-screen, raw-keypress UI in an interactive TTY.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Error: The interactive chat UI requires both stdin and stdout to be TTYs.\n" +
      "Run this command in an interactive terminal, or use a non-interactive CLI mode for CI or redirected environments."
    );
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  let running = true;
  let busy = false;
  let inputBuffer = "";
  let inputCursor = 0;
  let spinnerIndex = 0;
  let activeStatus: TurnStatus | undefined;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let selectedCommandIndex = 0;
  let paletteClosed = false;
  const inputHistory: string[] = [];
  let historyCursor: number | undefined;
  let historyDraft = "";
  let historySearchMode = false;
  let historySearchQuery = "";
  let historySearchIndex: number | undefined;
  let historySearchSnapshot = { buffer: "", cursor: 0 };
  let scrollOffset = 0; // lines scrolled up from bottom; 0 = bottom
  const transcript: string[] = [];

  const pushTranscript = (value: string): void => {
    const normalized = value.replace(/\r\n/g, "\n");
    for (const line of normalized.split("\n")) {
      transcript.push(line);
    }
    if (transcript.length > 3000) {
      transcript.splice(0, transcript.length - 3000);
    }
  };

  const getCommandPalette = (): CommandEntry[] => {
    const trimmed = inputBuffer.trim().toLowerCase();
    if (!trimmed.startsWith("/") || busy || paletteClosed) return [];
    if (trimmed === "/") return COMMANDS;

    return COMMANDS.filter((entry) => entry.command.startsWith(trimmed));
  };

  const getMentionContext = (): { start: number; end: number; query: string } | undefined => {
    if (busy || paletteClosed) return undefined;

    let start = inputCursor - 1;
    while (start >= 0 && !/\s/.test(inputBuffer[start])) {
      start -= 1;
    }
    start += 1;

    let end = inputCursor;
    while (end < inputBuffer.length && !/\s/.test(inputBuffer[end])) {
      end += 1;
    }

    const token = inputBuffer.slice(start, end);
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
        if (!valueLower.startsWith(scopedPrefix) || valueLower === scopedPrefix) {
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

  const findHistoryMatch = (query: string, startIndex?: number): number | undefined => {
    const q = query.trim().toLowerCase();
    if (!q) return undefined;

    let index = startIndex ?? (inputHistory.length - 1);
    while (index >= 0) {
      if (inputHistory[index].toLowerCase().includes(q)) {
        return index;
      }
      index -= 1;
    }
    return undefined;
  };

  const clearHistorySearch = (restoreSnapshot: boolean): void => {
    if (restoreSnapshot) {
      inputBuffer = historySearchSnapshot.buffer;
      inputCursor = historySearchSnapshot.cursor;
    }
    historySearchMode = false;
    historySearchQuery = "";
    historySearchIndex = undefined;
  };

  const draw = (): void => {
    const cols = Math.max(40, (process.stdout.columns || 80) - 1);
    const rows = Math.max(12, process.stdout.rows || 24);
    const activePalette = getActivePalette();
    const paletteItems = activePalette.items;
    const paletteVisible = paletteItems.length > 0;
    selectedCommandIndex = clamp(selectedCommandIndex, 0, Math.max(0, paletteItems.length - 1));

    const inputHeight = 3;
    const maxPaletteItems = Math.min(5, paletteItems.length);
    const paletteHeight = paletteVisible ? maxPaletteItems + 2 : 0;
    const outputHeight = Math.max(1, rows - inputHeight - paletteHeight);

    const statusLine = historySearchMode
      ? (() => {
        const head = `(reverse-i-search)\`${historySearchQuery}\`: `;
        if (historySearchIndex === undefined) {
          return `${head}no match`;
        }
        return `${head}${inputHistory[historySearchIndex]}`;
      })()
      : (busy && activeStatus
        ? `[REI] Thinking ${SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]} ${THINKING_TEXT[activeStatus]}`
        : scrollOffset > 0
          ? `↑ Scrolled up ${scrollOffset} lines — Ctrl+D to scroll down`
          : SHORTCUT_HINT);

    const messageSlots = statusLine ? outputHeight - 1 : outputHeight;
    const wrappedTranscriptLines = transcript.flatMap((line) =>
      wrapAnsi(line, cols, { hard: true, trim: false, wordWrap: true }).split("\n")
    );
    const totalWrapped = wrappedTranscriptLines.length;
    const maxScrollOffset = Math.max(0, totalWrapped - messageSlots);
    const effectiveOffset = Math.min(scrollOffset, maxScrollOffset);
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
      const listStart = Math.max(0, Math.min(selectedCommandIndex - maxPaletteItems + 1, paletteItems.length - maxPaletteItems));
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

    const promptText = MODE_PROMPTS[session.mode];
    const fullInput = `${promptText}${inputBuffer}`;
    const inputInnerWidth = Math.max(1, cols - 4);
    const inputAbsoluteCursor = promptText.length + inputCursor;
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

    process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
    process.stdout.write(screen.join("\r\n"));

    const inputLineRow = rows - 1;
    const inputColumn = 3 + cursorInViewport;
    process.stdout.write(`\x1b[${inputLineRow};${inputColumn}H\x1b[?25h`);
  };

  const stopSpinner = (): void => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  const startSpinner = (): void => {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      spinnerIndex += 1;
      draw();
    }, 100);
  };

  const resetInput = (): void => {
    clearHistorySearch(false);
    inputBuffer = "";
    inputCursor = 0;
    selectedCommandIndex = 0;
    paletteClosed = false;
    historyCursor = undefined;
    historyDraft = "";
    scrollOffset = 0; // snap to bottom on submit
  };

  const rememberHistory = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const last = inputHistory[inputHistory.length - 1];
    if (last !== value) {
      inputHistory.push(value);
    }
    if (inputHistory.length > 300) {
      inputHistory.splice(0, inputHistory.length - 300);
    }
    historyCursor = undefined;
    historyDraft = "";
  };

  const handleCommand = async (trimmed: string): Promise<boolean> => {
    if (trimmed === "/exit") {
      pushTranscript("Goodbye!");
      draw();
      running = false;
      return true;
    }

    if (trimmed === "/clear") {
      session.messages = [];
      transcript.length = 0;
      pushTranscript("History cleared.");
      return true;
    }

    if (trimmed === "/help") {
      pushTranscript(HELP_TEXT);
      return true;
    }

    if (trimmed === "/pending") {
      const pending = agent.getPendingPatches();
      if (pending.length === 0) {
        pushTranscript("No pending patches.");
        return true;
      }

      pushTranscript(`Pending patches: ${pending.length}`);
      for (const proposal of pending) {
        pushTranscript(`File: ${proposal.file}`);
        pushTranscript(`Reason: ${proposal.description || "(no description)"}`);
        pushTranscript(formatPatchForTerminal(proposal.patch));
      }
      pushTranscript("Use /confirm to apply, or /discard to clear them.");
      return true;
    }

    if (trimmed === "/discard") {
      const discarded = agent.clearPendingPatches();
      pushTranscript(discarded > 0 ? `Discarded ${discarded} pending patch(es).` : "No pending patches.");
      return true;
    }

    if (trimmed === "/confirm" || trimmed === "/confirm --dry-run") {
      const dryRun = trimmed.includes("--dry-run");
      const pending = agent.getPendingPatches();
      if (pending.length === 0) {
        pushTranscript("No pending patches to apply.");
        return true;
      }

      busy = true;
      activeStatus = "producing_response";
      startSpinner();
      draw();

      try {
        const result = await agent.applyPendingPatches({ dryRun });
        if (result.results.length === 0) {
          pushTranscript("No pending patches to apply.");
          return true;
        }

        pushTranscript(
          dryRun
            ? "Patch dry-run completed."
            : (result.success ? "Patches applied." : "Patch apply completed with errors.")
        );

        for (const item of result.results) {
          const status = item.applied ? "applied" : (item.skipped ? "skipped" : "failed");
          pushTranscript(`- ${item.file}: ${status}`);
          if (item.validationErrors.length > 0) {
            pushTranscript(`  validation: ${item.validationErrors.join(" | ")}`);
          }
          if (item.stderr) {
            pushTranscript(`  stderr: ${item.stderr.trim()}`);
          }
        }
      } catch (err: unknown) {
        pushTranscript(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        busy = false;
        activeStatus = undefined;
        stopSpinner();
      }

      return true;
    }

    const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/);
    if (modeMatch) {
      const requested = modeMatch[1];
      if (requested === "ask" || requested === "planning" || requested === "agent") {
        const previousMode = session.mode;
        session.mode = requested as SessionMode;
        if (previousMode === "agent" && session.mode !== "agent") {
          const systemMessages = session.messages.filter((m) => m.role === "system");
          session.messages = systemMessages;
        }
        pushTranscript(`[REI] Mode switched to: ${session.mode}`);
      } else {
        pushTranscript(`Unknown mode: ${requested}. Available modes: ask, planning, agent`);
      }
      return true;
    }

    return false;
  };

  const handleUserTurn = async (trimmed: string): Promise<void> => {
    busy = true;
    activeStatus = "building_context";
    spinnerIndex = 0;
    startSpinner();
    draw();

    try {
      let lastStatus: TurnStatus | undefined;
      let buffer = "";
      let liveStart = -1;

      for await (const token of agent.streamTurn(session, trimmed, {
        onStatus: (status) => {
          if (lastStatus === status) return;
          lastStatus = status;
          activeStatus = status;

          if (status === "producing_response" && liveStart < 0) {
            pushTranscript("");
            pushTranscript(`You: ${trimmed}`);
            pushTranscript("");
            liveStart = transcript.length;
            transcript.push(""); // live placeholder — spinner will redraw
          }
        },
      })) {
        buffer += token;
        if (liveStart >= 0) {
          const lines = buffer.split("\n");
          transcript.splice(liveStart, transcript.length - liveStart, ...lines);
          // No draw() here — spinner fires every 100ms and handles redraws.
          // Calling draw() per-token causes terminal artifact floods.
        }
      }

      if (liveStart >= 0) {
        // Finalize: replace raw streaming lines with rendered markdown
        const rendered = renderMarkdown(buffer);
        const lines = rendered.split("\n");
        transcript.splice(liveStart, transcript.length - liveStart, ...lines);
      } else {
        pushTranscript("");
        pushTranscript(`You: ${trimmed}`);
        pushTranscript("");
        pushTranscript(renderMarkdown(buffer));
      }
      pushTranscript("");
    } catch (err: unknown) {
      pushTranscript(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
      activeStatus = undefined;
      stopSpinner();
      draw();
    }
  };

  const submitInput = async (): Promise<void> => {
    if (busy) return;

    const activePalette = getActivePalette();
    const palette = activePalette.items;
    const submittedInput = inputBuffer;
    const trimmed = inputBuffer.trim();

    if (activePalette.kind === "mention" && palette.length > 0) {
      const mentionContext = getMentionContext();
      if (mentionContext) {
        const selected = activePalette.items[clamp(selectedCommandIndex, 0, activePalette.items.length - 1)];
        const selectedText = `@${selected.value}`;
        const trailing = inputBuffer.slice(mentionContext.end);
        const needsSpace = !selected.isDir && (trailing.length === 0 || !/^\s/.test(trailing));
        const suffix = needsSpace ? " " : "";
        inputBuffer =
          `${inputBuffer.slice(0, mentionContext.start)}${selectedText}${suffix}${inputBuffer.slice(mentionContext.end)}`;
        inputCursor = mentionContext.start + selectedText.length + suffix.length;
        selectedCommandIndex = 0;
        paletteClosed = !selected.isDir;
        draw();
      }
      return;
    }

    if (palette.length > 0 && trimmed === "/") {
      if (activePalette.kind !== "command") {
        draw();
        return;
      }
      const selected = activePalette.items[clamp(selectedCommandIndex, 0, activePalette.items.length - 1)];
      if (selected.requiresArgs) {
        inputBuffer = selected.command;
        inputCursor = inputBuffer.length;
        selectedCommandIndex = 0;
        paletteClosed = true;
        historyCursor = undefined;
        historyDraft = "";
        draw();
        return;
      }
      rememberHistory(selected.command);
      resetInput();
      const wasCommand = await handleCommand(selected.command);
      draw();
      if (!running || wasCommand) {
        return;
      }
    }

    resetInput();
    draw();

    if (!trimmed) {
      return;
    }

    rememberHistory(submittedInput);
    const wasCommand = await handleCommand(trimmed);
    draw();
    if (!running || wasCommand) {
      return;
    }

    await handleUserTurn(trimmed);
  };

  const onKeypress = (str: string, key: readline.Key): void => {
    if (!running) return;

    if (key.ctrl && key.name === "c") {
      if (historySearchMode) {
        clearHistorySearch(true);
        draw();
        return;
      }
      running = false;
      return;
    }

    if (key.ctrl && key.name === "r") {
      if (inputHistory.length === 0) {
        return;
      }

      if (!historySearchMode) {
        historySearchSnapshot = { buffer: inputBuffer, cursor: inputCursor };
        historySearchMode = true;
        historySearchQuery = "";
        historySearchIndex = undefined;
      } else if (historySearchQuery.trim()) {
        const start = historySearchIndex !== undefined ? historySearchIndex - 1 : inputHistory.length - 1;
        historySearchIndex = findHistoryMatch(historySearchQuery, start);
        if (historySearchIndex !== undefined) {
          inputBuffer = inputHistory[historySearchIndex];
          inputCursor = inputBuffer.length;
        }
      }

      draw();
      return;
    }

    if (historySearchMode) {
      if (key.name === "return" || key.name === "enter") {
        clearHistorySearch(false);
        draw();
        return;
      }

      if (key.name === "escape") {
        clearHistorySearch(true);
        draw();
        return;
      }

      if (key.name === "backspace") {
        if (historySearchQuery.length > 0) {
          historySearchQuery = historySearchQuery.slice(0, -1);
          historySearchIndex = findHistoryMatch(historySearchQuery);
          if (historySearchIndex !== undefined) {
            inputBuffer = inputHistory[historySearchIndex];
            inputCursor = inputBuffer.length;
          } else if (!historySearchQuery) {
            inputBuffer = historySearchSnapshot.buffer;
            inputCursor = historySearchSnapshot.cursor;
          }
        }
        draw();
        return;
      }

      if (str && !key.ctrl && !key.meta) {
        historySearchQuery += str;
        historySearchIndex = findHistoryMatch(historySearchQuery);
        if (historySearchIndex !== undefined) {
          inputBuffer = inputHistory[historySearchIndex];
          inputCursor = inputBuffer.length;
        }
        draw();
      }

      return;
    }

    if (key.name === "return" || key.name === "enter") {
      void submitInput();
      return;
    }

    // Scroll keys work regardless of busy state.
    // Ctrl+U = half page up, Ctrl+D = half page down (vim/less convention).
    // Also support PageUp/PageDown and Shift+arrows as fallback.
    if (key.name === "pageup" || (key.name === "up" && key.shift) || (key.ctrl && key.name === "u")) {
      const rows = Math.max(12, process.stdout.rows || 24);
      const pageSize = Math.max(1, Math.floor((rows - 4) / 2));
      scrollOffset += pageSize;
      draw();
      return;
    }

    if (key.name === "pagedown" || (key.name === "down" && key.shift) || (key.ctrl && key.name === "d")) {
      const rows = Math.max(12, process.stdout.rows || 24);
      const pageSize = Math.max(1, Math.floor((rows - 4) / 2));
      scrollOffset = Math.max(0, scrollOffset - pageSize);
      draw();
      return;
    }

    if (busy) {
      return;
    }

    const activePalette = getActivePalette();
    const palette = activePalette.items;
    if (key.name === "up") {
      if (historyCursor !== undefined) {
        historyCursor = Math.max(0, historyCursor - 1);
        inputBuffer = inputHistory[historyCursor];
        inputCursor = inputBuffer.length;
        selectedCommandIndex = 0;
        paletteClosed = true;
        draw();
        return;
      }

      if (palette.length > 0) {
        selectedCommandIndex = clamp(selectedCommandIndex - 1, 0, palette.length - 1);
        draw();
        return;
      }

      if (inputHistory.length === 0) {
        return;
      }
      if (historyCursor === undefined) {
        historyDraft = inputBuffer;
        historyCursor = inputHistory.length - 1;
      } else {
        historyCursor = Math.max(0, historyCursor - 1);
      }
      inputBuffer = inputHistory[historyCursor];
      inputCursor = inputBuffer.length;
      selectedCommandIndex = 0;
      paletteClosed = true;
      draw();
      return;
    }

    if (key.name === "down") {
      if (historyCursor !== undefined) {
        if (historyCursor < inputHistory.length - 1) {
          historyCursor += 1;
          inputBuffer = inputHistory[historyCursor];
        } else {
          historyCursor = undefined;
          inputBuffer = historyDraft;
          historyDraft = "";
        }
        inputCursor = inputBuffer.length;
        selectedCommandIndex = 0;
        paletteClosed = true;
        draw();
        return;
      }

      if (palette.length > 0) {
        selectedCommandIndex = clamp(selectedCommandIndex + 1, 0, palette.length - 1);
        draw();
        return;
      }

      draw();
      return;
    }

    if (palette.length > 0 && key.name === "tab") {
      if (activePalette.kind === "mention") {
        const selected = activePalette.items[clamp(selectedCommandIndex, 0, activePalette.items.length - 1)];
        const mentionContext = getMentionContext();
        if (!mentionContext) {
          draw();
          return;
        }
        const selectedText = `@${selected.value}`;
        const trailing = inputBuffer.slice(mentionContext.end);
        const needsSpace = !selected.isDir && (trailing.length === 0 || !/^\s/.test(trailing));
        const suffix = needsSpace ? " " : "";
        inputBuffer = `${inputBuffer.slice(0, mentionContext.start)}${selectedText}${suffix}${inputBuffer.slice(mentionContext.end)}`;
        inputCursor = mentionContext.start + selectedText.length + suffix.length;
        paletteClosed = !selected.isDir;
      } else {
        const selected = activePalette.items[clamp(selectedCommandIndex, 0, activePalette.items.length - 1)];
        inputBuffer = selected.command;
        inputCursor = inputBuffer.length;
        paletteClosed = false;
      }
      selectedCommandIndex = 0;
      draw();
      return;
    }

    if (key.name === "left") {
      inputCursor = Math.max(0, inputCursor - 1);
      historyCursor = undefined;
      historyDraft = "";
      draw();
      return;
    }

    if (key.name === "right") {
      inputCursor = Math.min(inputBuffer.length, inputCursor + 1);
      historyCursor = undefined;
      historyDraft = "";
      draw();
      return;
    }

    if (key.name === "backspace") {
      if (inputCursor > 0) {
        inputBuffer = `${inputBuffer.slice(0, inputCursor - 1)}${inputBuffer.slice(inputCursor)}`;
        inputCursor -= 1;
        selectedCommandIndex = 0;
        paletteClosed = false;
        historyCursor = undefined;
        historyDraft = "";
      }
      draw();
      return;
    }

    if (key.name === "delete") {
      if (inputCursor < inputBuffer.length) {
        inputBuffer = `${inputBuffer.slice(0, inputCursor)}${inputBuffer.slice(inputCursor + 1)}`;
        selectedCommandIndex = 0;
        paletteClosed = false;
        historyCursor = undefined;
        historyDraft = "";
      }
      draw();
      return;
    }

    if (key.name === "escape") {
      selectedCommandIndex = 0;
      paletteClosed = true;
      draw();
      return;
    }

    if (str && !key.ctrl && !key.meta) {
      inputBuffer = `${inputBuffer.slice(0, inputCursor)}${str}${inputBuffer.slice(inputCursor)}`;
      inputCursor += str.length;
      selectedCommandIndex = 0;
      paletteClosed = false;
      historyCursor = undefined;
      historyDraft = "";
      draw();
    }
  };

  const onResize = (): void => {
    draw();
  };

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopSpinner();
    process.stdin.off("keypress", onKeypress);
    process.stdout.off("resize", onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write("\x1b[?1049l\x1b[?25h"); // exit alternate screen buffer, show cursor
  };

  const onExit = (): void => cleanup();
  const onSigint = (): void => {
    cleanup();
    process.exit(130); // conventional exit code for SIGINT (128 + 2)
  };
  const onUncaughtException = (err: Error): void => {
    cleanup();
    // Re-throw so Node prints the error and exits with a non-zero code.
    throw err;
  };

  process.once("exit", onExit);
  process.once("SIGINT", onSigint);
  process.once("uncaughtException", onUncaughtException);

  process.stdin.on("keypress", onKeypress);
  process.stdout.on("resize", onResize);

  try {
    process.stdout.write("\x1b[?1049h"); // enter alternate screen buffer

    pushTranscript(getWelcomeMessage(session.mode));
    draw();

    while (running) {
      // Keep loop alive while keypress handlers drive the UI.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    process.off("uncaughtException", onUncaughtException);
    cleanup();
  }
}
