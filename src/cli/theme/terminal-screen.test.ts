import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  RESTORE_SEQUENCE,
  restoreTerminalScreen,
  syncTerminalScreen,
  _resetTerminalScreenForTests,
} from "./terminal-screen.js";
import { setTheme } from "./palette.js";

let out: string[];
const opts = (over: Partial<Parameters<typeof syncTerminalScreen>[0]> = {}) => ({
  write: (s: string) => void out.push(s),
  isTTY: true,
  env: {},
  onExit: () => {},
  ...over,
});

beforeEach(() => {
  out = [];
  _resetTerminalScreenForTests();
});
afterEach(() => setTheme(undefined));

/**
 * A phosphor theme only paints what REI colours; the text you type and the model's answer use the
 * terminal's own foreground. OSC 10/11/12 move that foreground, background and cursor to the
 * phosphor for as long as REI runs — which makes restoring them the half that matters: a terminal
 * left amber after REI exits is a bug the user has to fix by hand.
 */
describe("syncTerminalScreen", () => {
  it("paints the terminal's own colours with the phosphor", () => {
    setTheme("amber");
    syncTerminalScreen(opts());
    const seq = out.join("");
    expect(seq).toContain("\x1b]10;#ffb000\x07");
    expect(seq).toContain("\x1b]11;#0a0600\x07");
    expect(seq).toContain("\x1b]12;#ffc640\x07");
  });

  it("leaves the terminal alone for themes that are not a phosphor", () => {
    for (const name of ["default", "matrix"] as const) {
      setTheme(name);
      syncTerminalScreen(opts());
    }
    expect(out).toEqual([]);
  });

  it("restores the terminal when the theme moves off a phosphor", () => {
    setTheme("amber");
    syncTerminalScreen(opts());
    setTheme("default");
    syncTerminalScreen(opts());
    expect(out.at(-1)).toBe(RESTORE_SEQUENCE);
  });

  it("repaints when moving between phosphors, and does nothing when nothing changed", () => {
    setTheme("amber");
    syncTerminalScreen(opts());
    syncTerminalScreen(opts());
    expect(out).toHaveLength(1);
    setTheme("green");
    syncTerminalScreen(opts());
    expect(out).toHaveLength(2);
    expect(out[1]).toContain("\x1b]11;#010802\x07");
  });

  it("restores on exit — including an exit REI did not plan", () => {
    let onExit: (() => void) | undefined;
    setTheme("green");
    syncTerminalScreen(opts({ onExit: (fn) => void (onExit = fn) }));
    onExit?.();
    expect(out.at(-1)).toBe(RESTORE_SEQUENCE);
  });

  it("restores at most once", () => {
    setTheme("amber");
    syncTerminalScreen(opts());
    restoreTerminalScreen(opts());
    restoreTerminalScreen(opts());
    expect(out.filter((s) => s === RESTORE_SEQUENCE)).toHaveLength(1);
  });

  it("writes nothing when stdout is not a terminal — a pipe would carry the escapes into a file", () => {
    setTheme("amber");
    syncTerminalScreen(opts({ isTTY: false }));
    expect(out).toEqual([]);
  });

  it("can be turned off, for a terminal that mishandles the sequences", () => {
    setTheme("amber");
    syncTerminalScreen(opts({ env: { REI_TERMINAL_COLORS: "off" } }));
    expect(out).toEqual([]);
  });

  it("puts the terminal back if it is turned off after painting it", () => {
    setTheme("amber");
    syncTerminalScreen(opts());
    syncTerminalScreen(opts({ env: { REI_TERMINAL_COLORS: "off" } }));
    expect(out.at(-1)).toBe(RESTORE_SEQUENCE);
  });
});
