/**
 * Escalation policy for the "investigate-forever, produce-nothing" loop.
 *
 * The blocked-repeat guard only catches IDENTICAL re-issued commands. But a model can loop with
 * DIFFERENT read-only calls each turn — reading files, grepping, running commands — investigating
 * endlessly without ever producing a deliverable (an edit, a created file, or a final plan/answer).
 * Observed: a mid-size local model ran ~29 VARIED commands in planning mode and never emitted the
 * plan, burning every turn up to MAX_TURNS. This tracks consecutive investigation-only turns (tool
 * calls that changed nothing on disk) and escalates:
 *   - at `nudgeAt` → "nudge": inject a forceful "stop investigating, produce now" user message.
 *   - at `bailAt`  → "abandon": finalize with whatever was gathered instead of burning all turns.
 * Any productive turn (a queued edit or a created file) resets the streak. A no-tool-call turn is a
 * text response (the deliverable / exit) and is handled by the caller, so it resets too.
 */
export type NoProduceAction = "abandon" | "nudge" | "continue";

/**
 * Resolve the escalation thresholds. `nudgeAt` = investigate-only turns before the produce nudge;
 * `bailAt` = a few turns later, finalize instead of burning every turn up to MAX_TURNS.
 *
 * DISABLED by default (nudgeAt = 0) — the guard counts read-only/MCP tool calls as "investigate-only"
 * and can prematurely cut off legitimately read-heavy work (e.g. reading a Jira task over MCP, or
 * exploring a large repo). Re-enable it by setting REI_INVESTIGATE_BEFORE_PRODUCE=<n> (e.g. 8).
 */
export function produceThresholds(): { nudgeAt: number; bailAt: number } {
  const n = parseInt(process.env.REI_INVESTIGATE_BEFORE_PRODUCE ?? "", 10);
  const nudgeAt = Number.isFinite(n) && n >= 0 ? n : 0; // 0 = off (default)
  return { nudgeAt, bailAt: nudgeAt > 0 ? nudgeAt + 4 : 0 };
}

/** Forceful message injected as a user turn to force the model to commit to output. */
export const PRODUCE_NOW_MESSAGE =
  "STOP INVESTIGATING. You have made many tool calls (reads/commands/searches) WITHOUT producing " +
  "anything. Do NOT read files or run commands in your next response. Using ONLY the information " +
  "already gathered, produce your deliverable NOW: if a file change is needed, emit the " +
  "create_file/edit_file/rewrite_file tool call; otherwise write your final plan or answer as plain " +
  "text. If something is still missing, state your best answer with explicit assumptions — do not " +
  "investigate further.";

export function evaluateNoProduce(params: {
  /** Tool calls emitted this turn (0 = a text response, handled/exited by the caller). */
  toolCallCount: number;
  /** Did this turn change disk state — queue an edit or create a file? */
  producedDeliverable: boolean;
  /** Running streak of consecutive investigate-only turns coming into this turn. */
  investigateOnlyTurns: number;
  /** Streak at which to nudge once; and at which to give up (0 disables that step). */
  nudgeAt: number;
  bailAt: number;
}): { investigateOnlyTurns: number; action: NoProduceAction } {
  const { toolCallCount, producedDeliverable, investigateOnlyTurns, nudgeAt, bailAt } = params;

  if (toolCallCount === 0 || producedDeliverable) {
    return { investigateOnlyTurns: 0, action: "continue" };
  }

  const streak = investigateOnlyTurns + 1;
  if (bailAt > 0 && streak >= bailAt) {
    return { investigateOnlyTurns: streak, action: "abandon" };
  }
  if (nudgeAt > 0 && streak === nudgeAt) {
    return { investigateOnlyTurns: streak, action: "nudge" };
  }
  return { investigateOnlyTurns: streak, action: "continue" };
}
