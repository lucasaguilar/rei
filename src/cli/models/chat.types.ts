export type MentionEntry = {
  value: string;
  description: string;
  isDir: boolean;
};

export type CommandEntry = {
  command: string;
  description: string;
  requiresArgs?: boolean;
};

export type ActivePalette =
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

export interface ChatRendererState {
  cols: number;
  rows: number;
  activePalette: ActivePalette;
  selectedCommandIndex: number;
  historySearchMode: boolean;
  historySearchQuery: string;
  historySearchIndex?: number;
  inputHistory: string[];
  busy: boolean;
  activeStatus?: string; // TurnStatus
  spinnerIndex: number;
  scrollOffset: number;
  transcript: string[];
  sessionMode: string; // SessionMode
  inputBuffer: string;
  inputCursor: number;
}

export interface ChatUIState {
  running: boolean;
  busy: boolean;
  activeStatus?: string; // TurnStatus
  spinnerIndex: number;
  suppressAnsiInputUntil: number;

  historySearchMode: boolean;
  historySearchQuery: string;
  historySearchIndex: number | undefined;
  historySearchSnapshot: { buffer: string; cursor: number };

  inputBuffer: string;
  inputCursor: number;
  inputHistory: string[];
  historyCursor: number | undefined;
  historyDraft: string;

  selectedCommandIndex: number;
  paletteClosed: boolean;
  scrollOffset: number;
}

export interface KeyboardActions {
  draw(): void;
  clearHistorySearch(restoreSnapshot: boolean): void;
  findHistoryMatch(query: string, startIndex?: number): number | undefined;
  submitInput(): Promise<void> | void;
  getActivePalette(): ActivePalette;
  getMentionContext(): { start: number; end: number; query: string } | undefined;
}
