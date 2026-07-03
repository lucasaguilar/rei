import * as readline from "readline";
import { ANSI_REGEX, MODE_PROMPTS } from "../constants/chat.constants.js";
import type { SessionMode } from "../../chat/types.js";

export function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, "");
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

/**
 * Usable width for input TEXT (the wrap width), given the terminal columns and the mode prompt.
 * SINGLE SOURCE OF TRUTH shared by the renderer (to wrap the input into visual rows) and the
 * keyboard handler (to move the cursor between those rows on Up/Down) — so the two can never
 * disagree about where a visual line breaks. Mirrors the renderer's own `cols`/`promptLen` math.
 */
export function inputWrapWidth(sessionMode: string, cols: number): number {
  const c = Math.max(40, cols - 1);
  const promptLen = visibleLength(MODE_PROMPTS[sessionMode as SessionMode] ?? "");
  return Math.max(1, c - promptLen - 1);
}

export function takeVisible(value: string, width: number): string {
  if (width <= 0) return "";

  let out = "";
  let visible = 0;

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\u001b") {
      const rest = value.slice(i);
      // NOTE: Match standard ANSI escape sequences at the beginning of the remaining string
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

export function fitLine(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(value) <= width) return value;
  if (width === 1) return ".";
  return `${takeVisible(value, width - 1)}.`;
}

export function padRight(value: string, width: number): string {
  const len = visibleLength(value);
  if (len >= width) return value;
  return value + " ".repeat(width - len);
}

export function viewportForInput(text: string, cursor: number, width: number): { visible: string; start: number } {
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

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isMouseSgrSequence(str: string, key: readline.Key): boolean {
  const keyWithSequence = key as readline.Key & { sequence?: string };
  const sequence = keyWithSequence.sequence ?? str;
  // NOTE: Match SGR mouse sequences emitted by the terminal on clicks/scrolls
  return /\x1b\[<\d+;\d+;\d+[mM]/.test(sequence);
}

export function looksLikeAnsiNoise(str: string, key: readline.Key): boolean {
  const keyWithSequence = key as readline.Key & { sequence?: string };
  const sequence = keyWithSequence.sequence ?? str;

  // NOTE: Detect incomplete or full ANSI fragments arriving via terminal stream
  if (sequence.includes("\x1b")) return true;
  if (sequence.startsWith("[<")) return true; // NOTE: Common CSI fragment
  if (sequence.startsWith("\x1b[M")) return true; // NOTE: Legacy mouse protocol sequence
  // NOTE: Match incomplete SGR mouse sequences (e.g., missing escape code)
  if (/^\[<\d*;?\d*;?\d*[mM]?$/.test(sequence)) return true;
  // NOTE: Match characteristic ANSI trailing noise (digits, brackets, semicolons)
  if (/^[\[<;\dMm]+$/.test(sequence) && sequence.length <= 8) return true;
  return false;
}
