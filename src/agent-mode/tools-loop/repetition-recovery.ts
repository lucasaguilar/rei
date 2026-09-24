import type { ChatMessage } from "../../chat/types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import { finalizeOutcome, type ExecutionResult } from "../helpers/patch-helpers.js";

/**
 * Loop guard, phase 2: what happens AFTER the cut.
 *
 * Phase 1 detects a runaway generation and stops it (see helpers/loop-guard.ts). That alone ends the
 * turn on a half-sentence, which is the wrong ending for the common case: a model that repeats itself
 * for a while and then, left alone, finds its way out. The cut has no way to tell that apart from a
 * model that never will — so instead of deciding, it gives the model ONE clean second attempt.
 *
 * Two rules make the retry worth taking:
 *
 * 1. **The looping text is removed and never re-fed.** A model shown its own repetition continues it —
 *    that is the echo bug (docs: the reasoning-replay findings, and why preserve-thinking is off by
 *    default). So the cut output is dropped entirely: no assistant message, no summary of it, not even
 *    a quote of the phrase it got stuck on. The retry starts from exactly the context that preceded
 *    the loop, plus the instruction below.
 * 2. **The instruction opens two doors, both of which END the spiral.** A model loops when it cannot
 *    close: it keeps re-deriving because no available move looks finishable. "Try again" leaves it in
 *    the same position. So it is offered the two moves that always exist — answer briefly with what is
 *    already known, or ask the ONE question that would unblock it — and told not to resume its
 *    previous line of reasoning.
 *
 * If the retry loops too, that is the signal phase 1 could not give: this is not a model that was
 * about to resolve. Then REI stops for real and reports the levers.
 */

/** One retry per user-turn, total (not per loop iteration). A second cut is the real signal. */
export const MAX_REPETITION_RETRIES = 1;

/** Either retry the model call (looping output dropped, nudge queued) or give up with a result. */
export type RepetitionOutcome =
  | { action: "retry"; messages: ChatMessage[]; repetitionRetries: number }
  | { action: "finalize"; result: ExecutionResult };

/**
 * The recovery instruction, injected as a USER turn — the same reason the blocked-repeat guard uses
 * one: a tool result is easy for a stuck model to skim past, a user turn is not.
 *
 * `canAskUser` is false when no interactive frontend is attached (server, piped run). The ask_user
 * door is then removed rather than left to resolve to "the user did not answer", which would burn the
 * retry on a question nobody hears; the model is told to assume and say so instead.
 */
export function buildRepetitionRecovery(canAskUser: boolean): string {
  return [
    "STOP — your previous response got stuck repeating itself and was cut off. It has been discarded.",
    "Do NOT try to reconstruct it, and do NOT resume that line of reasoning: it was going nowhere.",
    "",
    "Using ONLY what is already above, do ONE of these now, in a SHORT response:",
    "  1. Answer directly — or make the single tool call that moves this forward. Brief. No restating.",
    canAskUser
      ? "  2. If you truly cannot proceed without a decision only the user can make, call `ask_user` " +
        "with the ONE question that would unblock you."
      : "  2. If something is genuinely undecidable from here, state the assumption you are making, " +
        "in one line, and continue on it.",
  ].join("\n");
}

/**
 * Handles a model call the loop guard cut for repetition. Called before anything else looks at the
 * response, so the cut output never reaches the history, `firstTurnExplanation`, or the tool
 * dispatcher (its tool calls may be truncated mid-JSON anyway).
 */
export async function handleRepetition(params: {
  currentMessages: ChatMessage[];
  repetitionRetries: number;
  /** Whether an interactive frontend is attached (an `ask_user` would actually reach someone). */
  canAskUser: boolean;
  logger: AgentLogger;
  emitStatus: (msg: string, kind?: "tool" | "notice") => void;
  virtualEdits: () => Promise<AgentSREdit[]>;
  firstTurnExplanation: string;
  appendCreatedSummary: (resp: string) => string;
}): Promise<RepetitionOutcome> {
  const {
    currentMessages,
    repetitionRetries,
    canAskUser,
    logger,
    emitStatus,
    virtualEdits,
    firstTurnExplanation,
    appendCreatedSummary,
  } = params;

  if (repetitionRetries < MAX_REPETITION_RETRIES) {
    logger.logInfo(
      `[loop-guard] repetition cut (${repetitionRetries + 1}/${MAX_REPETITION_RETRIES}) — ` +
        `dropping the looping output and retrying once`,
      { canAskUser },
    );
    // A NOTICE, not a tool: nothing was done, the turn is still going. Consumers that treat a
    // status as "narration ends here" must not discard what legitimately came before the loop.
    emitStatus("⚠️  [REI] The model started repeating itself — dropped it, retrying once", "notice");
    currentMessages.push({ role: "user", content: buildRepetitionRecovery(canAskUser) });
    return {
      action: "retry",
      messages: currentMessages,
      repetitionRetries: repetitionRetries + 1,
    };
  }

  // Twice in one user-turn. The retry was the test and the model failed it, so stop burning tokens
  // and hand back what was actually gathered (queued edits are work, not noise) plus the levers.
  logger.logInfo("[loop-guard] repetition again after the retry — giving up on this turn");
  const edits = await virtualEdits();
  return {
    action: "finalize",
    result: finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(
          firstTurnExplanation ||
            "⚠️ The model kept repeating itself, before and after one clean retry — it is not going " +
              "to finish this turn. What usually fixes it, in order:\n" +
              "  • shorten what it is being fed: a history full of diffs, git status and command " +
              "output is repetitive input, and repetitive input produces repetitive output;\n" +
              "  • raise this model's `REI_AGENT_FREQUENCY_PENALTY` on top of the presence penalty " +
              "(they are additive), or lower `REI_MAX_OUTPUT_TOKENS` to cap the damage;\n" +
              "  • if it was NOT actually repeating (a long answer with deliberately parallel " +
              "sections is the shape at risk), `REI_LOOP_GUARD=off` turns the check off.",
        ),
        validProposedPatches: edits,
      },
      edits.length,
      edits.length,
    ),
  };
}
