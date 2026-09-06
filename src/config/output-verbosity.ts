/**
 * How much of a turn's machinery reaches the screen.
 *
 * REI used to print everything: up to 20 lines of output per command, a full diff per edited file,
 * and the model's entire reasoning stream. On a reasoning model more than half the screen was
 * thinking — the answer was in there somewhere, and the tool calls that mattered scrolled past.
 *
 * Quiet is the default: one line per tool call, carrying its result. Detail appears where it is
 * actually needed — a command that FAILED still shows its output, because that is the case you have
 * to read. `--verbose` (or REI_VERBOSE=true) restores everything.
 */

let override: boolean | undefined;

/** `/verbose on|off` — flips it mid-session without a restart. */
export function setVerboseOutput(value: boolean | undefined): void {
  override = value;
}

export function isVerboseOutput(): boolean {
  if (override !== undefined) return override;
  return process.env.REI_VERBOSE === "true";
}

/** Lines of a FAILED command's output to show in quiet mode. Enough to diagnose, not a flood. */
export const FAILED_COMMAND_TAIL_LINES = 10;
