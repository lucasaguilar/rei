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
  sessionMode: string; // SessionMode
  inputBuffer: string;
  inputCursor: number;
}

export interface ChatUIState {
  running: boolean;
  busy: boolean;
  activeStatus?: string; // TurnStatus
  spinnerIndex: number;

  historySearchMode: boolean;
  historySearchQuery: string;
  historySearchIndex: number | undefined;
  historySearchSnapshot: { buffer: string; cursor: number };

  inputBuffer: string;
  inputCursor: number;
  inputHistory: string[];
  historyCursor: number | undefined;
  historyDraft: string;

  // True while consuming a bracketed-paste burst (between paste-start and
  // paste-end), so Enter inside the paste inserts a newline instead of submitting.
  pasting: boolean;

  selectedCommandIndex: number;
  paletteClosed: boolean;
  cols: number;
  rows: number;
  sessionMode: string; // SessionMode — kept in sync each draw so key handling knows the prompt width
}

export interface KeyboardActions {
  draw(): void;
  clearHistorySearch(restoreSnapshot: boolean): void;
  findHistoryMatch(query: string, startIndex?: number): number | undefined;
  submitCurrentUserInput(): Promise<void> | void;
  getActivePalette(): ActivePalette;
  getMentionContext():
    | { start: number; end: number; query: string }
    | undefined;
}
