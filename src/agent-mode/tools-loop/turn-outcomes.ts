import type { ChatMessage } from "../../chat/types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import {
  finalizeOutcome,
  validateProposedPatches,
  type ExecutionResult,
} from "../helpers/patch-helpers.js";

// Caps how many times a turn that truncated mid-output (hit the output-token cap before emitting
// a tool call — common with thinking models) is continued back into the loop.
export const MAX_TRUNCATION_CONTINUATIONS = 3;
export const TRUNCATION_CONTINUATION =
  "Your previous response was cut off by the output token limit. " +
  "Continue EXACTLY from where you left off — do NOT repeat, summarize, or restart. " +
  "Just continue the text as one uninterrupted response.";

/** Either re-enter the loop (continuation nudge queued) or finish with this ExecutionResult. */
export type TruncationOutcome =
  | { action: "continue"; messages: ChatMessage[]; truncationContinuations: number }
  | { action: "finalize"; result: ExecutionResult };

/**
 * Handles a response truncated by the output-token cap before any tool call. While budget remains,
 * preserve the partial output, nudge the model to continue, and re-enter the loop so the
 * continuation's tool calls get processed. Once exhausted, apply whatever was validated on-green
 * and report honestly. Extracted from executeAgentTurnWithTools (Phase 2).
 */
export async function handleTruncation(params: {
  content: string;
  reasoning?: string;
  currentMessages: ChatMessage[];
  truncationContinuations: number;
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
  virtualEdits: () => Promise<AgentSREdit[]>;
  firstTurnExplanation: string;
  appendCreatedSummary: (resp: string) => string;
}): Promise<TruncationOutcome> {
  const {
    content,
    reasoning,
    currentMessages,
    truncationContinuations,
    logger,
    emitStatus,
    virtualEdits,
    firstTurnExplanation,
    appendCreatedSummary,
  } = params;

  if (truncationContinuations < MAX_TRUNCATION_CONTINUATIONS) {
    logger.logInfo(
      `[truncation] response cut off (${truncationContinuations + 1}/${MAX_TRUNCATION_CONTINUATIONS}) — continuing into the loop`,
    );
    emitStatus("⏳  [REI] Response hit the output limit — continuing");
    currentMessages.push(
      {
        role: "assistant",
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      },
      { role: "user", content: TRUNCATION_CONTINUATION },
    );
    return {
      action: "continue",
      messages: currentMessages,
      truncationContinuations: truncationContinuations + 1,
    };
  }

  // Exhausted the TOTAL truncation budget for this turn — bail out instead of burning more tokens.
  // A thinking model that emits max-output pure reasoning (empty content) every turn will otherwise
  // loop here. Two real fixes: give it room to finish (raise the output cap) OR turn thinking off.
  logger.logInfo(
    `[truncation] gave up after ${MAX_TRUNCATION_CONTINUATIONS} truncations this turn — likely over-thinking (reasoning fills the output cap before any answer)`,
  );
  const truncEdits = await virtualEdits();
  return {
    action: "finalize",
    result: finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(
          firstTurnExplanation ||
            "⚠️ The model kept generating only reasoning (no answer) past the output-token limit — " +
              "it over-thinks. Fix ONE of:\n" +
              "  • raise REI_MAX_OUTPUT_TOKENS (e.g. 8192+) so it can finish reasoning + answer in one turn, OR\n" +
              "  • disable thinking for this mode: REI_REASONING_EFFORT_<MODE>=none " +
              "(qwen-style models are binary — low/medium don't cap it, only `none` turns it off).",
        ),
        validProposedPatches: truncEdits,
      },
      truncEdits.length,
      truncEdits.length,
    ),
  };
}

/**
 * Builds the terminal ExecutionResult when the loop hits MAX_TURNS without the model signalling
 * completion. If edits were queued along the way, apply them (with one honest final verify) rather
 * than discard the work; otherwise report the failure with guidance. Extracted from
 * executeAgentTurnWithTools (Phase 2).
 */
export async function buildTurnLimitOutcome(params: {
  loopCount: number;
  maxTurns: number;
  workspacePath: string;
  directMode: boolean;
  logger: AgentLogger;
  virtualEdits: () => Promise<AgentSREdit[]>;
  firstTurnExplanation: string;
  appendCreatedSummary: (resp: string) => string;
}): Promise<ExecutionResult> {
  const {
    loopCount,
    maxTurns,
    workspacePath,
    directMode,
    logger,
    virtualEdits,
    firstTurnExplanation,
    appendCreatedSummary,
  } = params;

  const limitEdits = await virtualEdits();
  if (limitEdits.length > 0) {
    const finalCheck = await validateProposedPatches({
      workspacePath,
      edits: directMode ? [] : limitEdits,
      loopCount,
      logger,
    });
    return finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(
          firstTurnExplanation ||
            `Applied ${limitEdits.length} edit(s); stopped at the ${maxTurns}-turn limit (there may be more to do).`,
        ),
        validProposedPatches: limitEdits,
        verified: finalCheck.success,
      },
      limitEdits.length,
      limitEdits.length,
    );
  }

  return finalizeOutcome(
    logger,
    {
      response: [
        `⚠️ REI could not complete the task after ${loopCount} attempts.`,
        "",
        ...(firstTurnExplanation
          ? ["**What was planned:**", firstTurnExplanation, ""]
          : []),
        "**What to try next:**",
        '- Ask REI to re-read the files first: *"Read [file] and retry"*',
        `- Increase the turn limit: set \`REI_MAX_TURNS=${maxTurns + 3}\` in your .env`,
      ].join("\n"),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}
