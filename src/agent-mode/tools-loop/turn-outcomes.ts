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

  // Exhausted continuations. Apply whatever was validated on-green and report honestly
  // (raising REI_MAX_OUTPUT_TOKENS is the real fix for a model that keeps truncating).
  logger.logInfo(
    `[truncation] gave up after ${MAX_TRUNCATION_CONTINUATIONS} continuations — output cap too low for this model?`,
  );
  const truncEdits = await virtualEdits();
  return {
    action: "finalize",
    result: finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(
          firstTurnExplanation ||
            "⚠️ The model kept hitting the output-token limit before finishing. " +
              "Increase REI_MAX_OUTPUT_TOKENS (thinking models need room for reasoning + the tool call).",
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
