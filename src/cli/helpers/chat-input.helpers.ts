import { COMMANDS } from "../constants/chat.constants.js";
import {
  type ActivePalette,
  type ChatUIState,
  type CommandEntry,
  type MentionEntry,
} from "../models/chat.types.js";

export function getCommandPalette(state: ChatUIState): CommandEntry[] {
  const trimmed = state.inputBuffer.trim().toLowerCase();
  if (!trimmed.startsWith("/") || state.busy || state.paletteClosed) {
    return [];
  }
  if (trimmed === "/") {
    return COMMANDS;
  }

  return COMMANDS.filter((entry) => entry.command.startsWith(trimmed));
}

export function getMentionContext(
  state: ChatUIState,
): { start: number; end: number; query: string } | undefined {
  if (state.busy || state.paletteClosed) {
    return undefined;
  }

  let start = state.inputCursor - 1;
  while (start >= 0 && !/\s/.test(state.inputBuffer[start])) {
    start -= 1;
  }
  start += 1;

  let end = state.inputCursor;
  while (end < state.inputBuffer.length && !/\s/.test(state.inputBuffer[end])) {
    end += 1;
  }

  const token = state.inputBuffer.slice(start, end);
  if (!token.startsWith("@")) {
    return undefined;
  }

  return {
    start,
    end,
    query: token.slice(1).toLowerCase(),
  };
}

export function getMentionPalette(
  state: ChatUIState,
  mentionEntries: MentionEntry[],
): MentionEntry[] {
  const context = getMentionContext(state);
  if (!context) {
    return [];
  }

  const query = context.query;
  const lowerQuery = query.toLowerCase();
  const scopedPrefix = lowerQuery.endsWith("/") ? lowerQuery : undefined;

  const items = mentionEntries.filter((entry) => {
    const valueLower = entry.value.toLowerCase();

    if (!lowerQuery) {
      return true;
    }

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
}

export function getActivePalette(
  state: ChatUIState,
  mentionEntries: MentionEntry[],
): ActivePalette {
  const mentionItems = getMentionPalette(state, mentionEntries);
  if (mentionItems.length > 0) {
    return { kind: "mention", items: mentionItems };
  }

  const commandItems = getCommandPalette(state);
  if (commandItems.length > 0) {
    return { kind: "command", items: commandItems };
  }

  return { kind: "none", items: [] };
}

export function findHistoryMatch(
  inputHistory: string[],
  query: string,
  startIndex?: number,
): number | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return undefined;
  }

  let index = startIndex ?? inputHistory.length - 1;
  while (index >= 0) {
    if (inputHistory[index].toLowerCase().includes(normalizedQuery)) {
      return index;
    }
    index -= 1;
  }

  return undefined;
}

export function clearHistorySearchState(
  state: ChatUIState,
  restoreSnapshot: boolean,
): void {
  if (restoreSnapshot) {
    state.inputBuffer = state.historySearchSnapshot.buffer;
    state.inputCursor = state.historySearchSnapshot.cursor;
  }

  state.historySearchMode = false;
  state.historySearchQuery = "";
  state.historySearchIndex = undefined;
}
