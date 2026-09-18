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
 *
 * The REASONING is the exception, and has its own switch. It is the one piece of the machinery that
 * makes a local model feel alive rather than hung: it starts long before the first tool call, and
 * it is the fastest way to see that the thing is working and what it is working on. So it is ON by
 * default (REI_SHOW_REASONING=false turns it off), independently of the command output and the
 * diffs — which were the actual source of the noise this module exists to cut.
 */

let override: boolean | undefined;
let reasoningOverride: boolean | undefined;

/** `/verbose on|off` — flips it mid-session without a restart. */
export function setVerboseOutput(value: boolean | undefined): void {
  override = value;
}

export function isVerboseOutput(): boolean {
  if (override !== undefined) return override;
  return process.env.REI_VERBOSE === "true";
}

/** `/reasoning on|off` — flips the thinking stream mid-session without a restart. */
export function setShowReasoning(value: boolean | undefined): void {
  reasoningOverride = value;
}

/**
 * Whether the model's thinking streams to the screen.
 *
 * Default ON. Verbose implies it, so `--verbose` / `/verbose on` still shows everything; turning
 * verbose back off leaves the reasoning where the user put it, because the two are now separate
 * questions. `REI_SHOW_REASONING=false` (or `0`) is the opt-out, for a chatty reasoning model where
 * the thinking buries the answer.
 */
export function isReasoningShown(): boolean {
  if (reasoningOverride !== undefined) return reasoningOverride;
  if (isVerboseOutput()) return true;
  const raw = process.env.REI_SHOW_REASONING?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Lines of a FAILED command's output to show in quiet mode. Enough to diagnose, not a flood. */
export const FAILED_COMMAND_TAIL_LINES = 10;
