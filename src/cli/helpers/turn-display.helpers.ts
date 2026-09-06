import { formatCodeDiff } from "../markdown-renderer.js";
import { isVerboseOutput } from "../../config/output-verbosity.js";

/**
 * How a finished turn's machinery is rendered — the parts whose SIZE is the question, kept apart
 * from the streaming loop that produces them.
 *
 * Quiet is the default. A successful command's output, a full diff and the model's reasoning are
 * all things you occasionally want and usually do not; printing them every time buried the tool
 * calls and the answer under everything that led to them.
 */

/** One line naming the reasoning that ran, instead of the reasoning itself. */
export function formatThinkingSummary(chars: number): string {
  // ~4 chars per token is the usual English/Spanish approximation; the point is the magnitude, not
  // an exact count — "did it think briefly or for a page?".
  return `\x1b[3;2m💭  thought for ${Math.round(chars / 4)} tokens\x1b[0m\n`;
}

export interface DisplayEdit {
  file: string;
  search: string;
  replace: string;
}

/** The edits a turn applied: `file +N -M` when quiet, the full hunks when verbose. */
export function formatEdits(edits: readonly DisplayEdit[]): string[] {
  if (edits.length === 0) return [];
  const out: string[] = ["\n\x1b[1;33mChanges:\x1b[0m"];
  for (const edit of edits) {
    if (isVerboseOutput()) {
      out.push(
        `\x1b[1mFile:\x1b[0m ${edit.file}\n${formatCodeDiff(edit.search, edit.replace)}`,
      );
      continue;
    }
    // A count, not the hunk: the edit already landed and was verified, so the diff is review
    // material — `git diff` shows it whenever it is actually wanted.
    const added = edit.replace ? edit.replace.split("\n").length : 0;
    const removed = edit.search ? edit.search.split("\n").length : 0;
    out.push(`  \x1b[1m${edit.file}\x1b[0m  \x1b[32m+${added}\x1b[0m \x1b[31m-${removed}\x1b[0m`);
  }
  return out;
}

/** State the status line and the sticky context bar read between draws. */
export interface PhaseState {
  activeStatus?: string;
  activeStatusText?: string;
  statusStartedAt?: number;
  contextTokens?: number;
  contextWindow?: number;
  modelLabel?: string;
}

/**
 * Publishes a turn's context reading to the sticky bar.
 *
 * Deliberately the LAST turn's number: the bar is redrawn on every keystroke, and re-estimating the
 * whole history there would put a full token count in the input loop.
 */
export function publishContextReading(
  state: PhaseState,
  tokens: number,
  window: number,
  model: string,
): void {
  state.contextTokens = tokens;
  state.contextWindow = window;
  state.modelLabel = model;
}

/**
 * Enters a phase: it owns the label, and its clock starts now.
 *
 * The clock is the reason this is one call rather than three assignments at each site — a phase
 * that changes without restarting it shows a stale duration, which is exactly the "is it stuck?"
 * question the elapsed count exists to answer.
 */
export function beginPhase(state: PhaseState, status: string): void {
  state.activeStatus = status;
  state.activeStatusText = undefined;
  state.statusStartedAt = Date.now();
}
