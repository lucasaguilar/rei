import type { CommandHandler, CommandResult } from "./command-handler.js";
import { isVerboseOutput, setVerboseOutput } from "../../config/output-verbosity.js";

/**
 * `/verbose [on|off]` — how much of the machinery reaches the screen.
 *
 * Quiet is the default: one line per tool call, a command's output only when it FAILED, edits as
 * `+N -M`, and the reasoning summarised rather than streamed. Verbose restores all of it, which is
 * what you want when REI is doing something surprising and you need to watch it happen.
 */
const VERBOSE_RE = /^\/verbose(?:\s+(on|off))?$/i;

export const verboseCommands: CommandHandler = {
  match: (c) => VERBOSE_RE.test(c.trim()),

  run: ({ command }): CommandResult => {
    const value = command.trim().match(VERBOSE_RE)?.[1]?.toLowerCase();
    if (!value) {
      return {
        success: true,
        recordInSession: false,
        response:
          `[REI] Verbose output is ${isVerboseOutput() ? "ON" : "OFF"}.\n` +
          `  OFF — one line per tool call; a command's output only when it fails; edits as +N -M.\n` +
          `  ON  — full command output, full diffs, and the model's reasoning as it streams.\n` +
          `  /verbose on | /verbose off`,
      };
    }
    setVerboseOutput(value === "on");
    return {
      success: true,
      recordInSession: false,
      response: `[REI] Verbose output ${value === "on" ? "ON — showing everything." : "OFF — tool calls only."}`,
    };
  },
};
