import { describe, it, expect, beforeEach } from "vitest";
import type * as readline from "readline";
import { KeyboardHandler } from "./keyboard-handler.js";
import type { ChatUIState, KeyboardActions } from "../models/chat.types.js";

function makeState(): ChatUIState {
  return {
    running: true,
    busy: false,
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
    cols: 80,
    rows: 24,
  } as ChatUIState;
}

describe("KeyboardHandler: bracketed paste", () => {
  let state: ChatUIState;
  let submits: number;
  let actions: KeyboardActions;

  beforeEach(() => {
    state = makeState();
    submits = 0;
    actions = {
      draw() {},
      submitCurrentUserInput() {
        submits++;
      },
      getActivePalette() {
        return { kind: "command", items: [] };
      },
      getMentionContext() {
        return null;
      },
      clearHistorySearch() {},
      findHistoryMatch() {
        return undefined;
      },
    } as unknown as KeyboardActions;
  });

  const press = (str: string | undefined, key: Partial<readline.Key>): void =>
    KeyboardHandler.handleKeypress(str as string, key as readline.Key, state, actions);

  const type = (text: string): void => {
    for (const ch of text) press(ch, { name: ch, sequence: ch });
  };
  const enter = (): void => press("\r", { name: "return", sequence: "\r" });

  it("treats newlines inside a paste as literal text, not submits", () => {
    press(undefined, { name: "paste-start" });
    type("hola");
    enter();
    type("que tal");
    enter();
    type("adios");
    press(undefined, { name: "paste-end" });

    // Nothing submitted during the paste; buffer holds all three lines.
    expect(submits).toBe(0);
    expect(state.inputBuffer).toBe("hola\nque tal\nadios");
    expect(state.pasting).toBe(false);

    // A real Enter afterwards submits exactly once.
    enter();
    expect(submits).toBe(1);
  });

  it("submits normally on Enter when not pasting", () => {
    type("hello");
    enter();
    expect(submits).toBe(1);
    expect(state.inputBuffer).toBe("hello");
  });
});
