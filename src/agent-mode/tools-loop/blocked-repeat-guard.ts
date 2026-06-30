/**
 * Escalation policy for the run_command loop-guard.
 *
 * The dispatcher already BLOCKS an exact-repeat command (returns a nudge instead of executing it),
 * but blocking alone doesn't rescue a stuck model: it ignores the per-command tool-result nudge and
 * keeps re-emitting the same command, burning turns up to MAX_TURNS. This decides, per turn, when a
 * turn was nothing-but-blocked-repeats and how to escalate:
 *   - 1st such turn  → "nudge": inject a forceful user-role STOP message (more salient than a tool
 *                       result).
 *   - 2nd in a row   → "abandon": give up the loop and finalize with whatever was gathered.
 * Any productive turn resets the streak.
 */
export type BlockedRepeatAction = "abandon" | "nudge" | "continue";

/** The forceful stop message injected as a user turn after the first all-blocked turn. */
export const BLOCKED_REPEAT_STOP_MESSAGE =
  "STOP — you just re-issued a command that was already run and blocked; running it again cannot " +
  "help. Do NOT call any tool in your next response. Using ONLY the information already gathered " +
  "above, either write your final answer now or, if a file change is required, emit the " +
  "edit_file/create_file/rewrite_file tool call to make it.";

export function evaluateBlockedRepeats(params: {
  /** Tool calls the model emitted this turn. */
  toolCallCount: number;
  /** How many of them were intercepted as exact run_command repeats. */
  blockedRepeatCount: number;
  /** Running streak of consecutive all-blocked turns coming into this turn. */
  consecutiveBlockedTurns: number;
  /** Streak length at which to abandon the loop. */
  maxBlockedTurns: number;
}): { consecutiveBlockedTurns: number; action: BlockedRepeatAction } {
  const { toolCallCount, blockedRepeatCount, consecutiveBlockedTurns, maxBlockedTurns } = params;

  const onlyBlockedRepeats =
    toolCallCount > 0 && blockedRepeatCount >= toolCallCount;
  if (!onlyBlockedRepeats) {
    return { consecutiveBlockedTurns: 0, action: "continue" };
  }

  const streak = consecutiveBlockedTurns + 1;
  return {
    consecutiveBlockedTurns: streak,
    action: streak >= maxBlockedTurns ? "abandon" : "nudge",
  };
}
