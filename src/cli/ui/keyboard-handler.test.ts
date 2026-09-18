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
    sessionMode: "agent",
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

/**
 * Typing while a turn runs. The queue (state.queuedUserMessages) was built to catch a line typed
 * mid-turn — "the token is in ~/.config/…" — instead of dropping it. It looked broken in practice:
 * a blanket `if (state.busy) return` sat between the Enter branch and every editing key, so the
 * characters never reached the buffer and Enter always submitted an empty line.
 */
describe("KeyboardHandler while a turn is running", () => {
  let state: ChatUIState;
  let submits: number;
  let actions: KeyboardActions;

  beforeEach(() => {
    state = makeState();
    state.busy = true;
    submits = 0;
    actions = {
      draw() {},
      submitCurrentUserInput() {
        submits++;
      },
      // While busy the palette is empty — chat-input.helpers refuses to build one.
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

  it("accepts typed characters into the input buffer", () => {
    type("pará, estás sobrepensando");
    expect(state.inputBuffer).toBe("pará, estás sobrepensando");
    expect(state.inputCursor).toBe("pará, estás sobrepensando".length);
  });

  it("submits what was typed instead of an empty line", () => {
    type("usá el archivo viejo");
    press("\r", { name: "return", sequence: "\r" });
    expect(submits).toBe(1);
    expect(state.inputBuffer).toBe("usá el archivo viejo");
  });

  it("still edits: backspace, delete and cursor movement all apply", () => {
    type("hulaa");
    press(undefined, { name: "backspace" });
    expect(state.inputBuffer).toBe("hula");
    press(undefined, { name: "left" });
    press(undefined, { name: "left" });
    press(undefined, { name: "delete" });
    expect(state.inputBuffer).toBe("hua");
  });

  it("clears the draft on escape, as it does when idle", () => {
    type("no, mejor no");
    press(undefined, { name: "escape" });
    expect(state.inputBuffer).toBe("");
    expect(state.inputCursor).toBe(0);
  });
});
