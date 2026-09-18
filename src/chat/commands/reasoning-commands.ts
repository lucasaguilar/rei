import type { CommandHandler, CommandResult } from "./command-handler.js";
import { isReasoningShown, setShowReasoning } from "../../config/output-verbosity.js";

/**
 * `/reasoning [on|off]` — whether the model's thinking streams to the screen.
 *
 * Separate from `/verbose` on purpose: the thinking is what makes a local model feel alive (it
 * starts long before the first tool call), while the full command output and the full diffs are
 * what made the screen unreadable. So this one is ON by default and that one is not.
 */
const REASONING_RE = /^\/reasoning(?:\s+(on|off))?$/i;

export const reasoningCommands: CommandHandler = {
  match: (c) => REASONING_RE.test(c.trim()),

  run: ({ command }): CommandResult => {
    const value = command.trim().match(REASONING_RE)?.[1]?.toLowerCase();
    if (!value) {
      return {
        success: true,
        recordInSession: false,
        response:
          `[REI] Reasoning stream is ${isReasoningShown() ? "ON" : "OFF"}.\n` +
          `  ON  — the model's thinking is drawn as a live paragraph above the status line.\n` +
          `  OFF — the thinking is counted and summarised as one line per block.\n` +
          `  /reasoning on | /reasoning off  ·  REI_SHOW_REASONING=false to default it off,\n` +
          `  REI_THINKING_LINES=<n> for its height`,
      };
    }
    setShowReasoning(value === "on");
    return {
      success: true,
      recordInSession: false,
      response: `[REI] Reasoning ${value === "on" ? "ON — drawn above the status line." : "OFF — counting it only."}`,
    };
  },
};
