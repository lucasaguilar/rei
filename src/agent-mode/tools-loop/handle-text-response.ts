import type { ChatMessage } from "../../chat/types.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { AgentLogger } from "../../core/logger.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import {
  finalizeOutcome,
  validateProposedPatches,
  type ExecutionResult,
} from "../helpers/patch-helpers.js";
import { buildFinalResponse } from "./finalize-response.js";
import {
  looksLikeAttemptedToolCall,
  looksLikeUnfulfilledAnnouncement,
} from "./tool-call-detection.js";

// Caps the number of format-correction nudges when the model emits a tool call as text/XML
// instead of via the native function-calling interface.
export const MAX_FORMAT_CORRECTIONS = 2;
// Caps how many times we bounce a failing FINAL verify back to the model for self-correction
// before giving up (and applying with a not-verified warning).
export const MAX_VERIFY_RETRIES = 2;

/**
 * What to do after the model returns NO tool calls in a turn:
 *  - `continue`: re-enter the loop (a format-correction nudge or a final-verify self-correction
 *    was queued). Carries the updated messages + bumped counters back to the caller.
 *  - `finalize`: the turn is done — return this ExecutionResult.
 */
export type TextResponseOutcome =
  | {
      action: "continue";
      messages: ChatMessage[];
      formatCorrections: number;
      verifyRetries: number;
    }
  | { action: "finalize"; result: ExecutionResult };

/**
 * Handles the "model produced a plain-text response (no tool calls)" branch of the native loop.
 * Three sub-cases, in order:
 *  1. The model wrote a tool call as TEXT/XML instead of calling it → nudge it back to the native
 *     interface and continue (bounded by MAX_FORMAT_CORRECTIONS).
 *  2. Genuine completion → run ONE final verify of the queued set; on failure with budget left,
 *     bounce the diagnostics back for self-correction and continue (bounded by MAX_VERIFY_RETRIES).
 *  3. Otherwise build the user-facing response and finalize.
 * Extracted from executeAgentTurnWithTools (Phase 2) — pure decision logic, no loop state of its own.
 */
export async function handleTextResponse(params: {
  content: string;
  currentMessages: ChatMessage[];
  loopCount: number;
  maxTurns: number;
  formatCorrections: number;
  verifyRetries: number;
  workspacePath: string;
  directMode: boolean;
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
  provider: ModelProvider;
  modelOverride?: string;
  firstTurnExplanation: string;
  virtualFiles: Map<string, string>;
  virtualEdits: () => Promise<AgentSREdit[]>;
  createdFiles: string[];
  appendCreatedSummary: (resp: string) => string;
}): Promise<TextResponseOutcome> {
  const {
    content,
    currentMessages,
    loopCount,
    maxTurns,
    formatCorrections,
    verifyRetries,
    workspacePath,
    directMode,
    logger,
    emitStatus,
    provider,
    modelOverride,
    firstTurnExplanation,
    virtualFiles,
    virtualEdits,
    createdFiles,
    appendCreatedSummary,
  } = params;

  // The model sometimes emits a tool call as TEXT/XML (e.g. "<read_files>...") instead of using
  // the native function-calling interface. That would be lost as a plain-text answer. Nudge it
  // back to the proper format and retry.
  if (
    looksLikeAttemptedToolCall(content) &&
    formatCorrections < MAX_FORMAT_CORRECTIONS &&
    loopCount < maxTurns
  ) {
    logger.logInfo("[tools] format-correction", {
      attempt: formatCorrections + 1,
      contentPreview: content.slice(0, 120),
    });
    // Surface the recovery so the user knows why the turn took another round-trip (and, if the
    // detector ever misfires, that it happened — they can re-ask). Subtle status, not an alarm.
    emitStatus(
      "↩️  [REI] Model wrote a tool call as text — asking it to retry as a real tool call",
    );
    return {
      action: "continue",
      messages: [
        ...currentMessages,
        { role: "assistant", content },
        {
          role: "user",
          content:
            "You emitted a tool call as text/XML, which is not executable. " +
            "Do NOT write tool calls as text or XML tags. Use the native function-calling " +
            "interface to invoke the tools (read_files, edit_file, create_file, run_command) directly. " +
            "Retry the same action now using a proper tool call.",
        },
      ],
      formatCorrections: formatCorrections + 1,
      verifyRetries,
    };
  }

  // NARRATE-DON'T-ACT guard: the model announced an investigation ("leamos los archivos", "let me
  // read") but emitted no tool call and produced no real answer — a weak-local-model failure where it
  // describes the action instead of doing it (common on the read-only ask/planning path). Nudge it to
  // actually call the tool (or answer). Shares the format-correction budget so it can't loop.
  if (
    looksLikeUnfulfilledAnnouncement(content) &&
    formatCorrections < MAX_FORMAT_CORRECTIONS &&
    loopCount < maxTurns
  ) {
    logger.logInfo("[tools] narrate-don't-act nudge", {
      attempt: formatCorrections + 1,
      contentPreview: content.slice(0, 120),
    });
    emitStatus(
      "↩️  [REI] Model announced an action without doing it — asking it to actually call the tool",
    );
    return {
      action: "continue",
      messages: [
        ...currentMessages,
        { role: "assistant", content },
        {
          role: "user",
          content:
            "You said you would read/inspect files but did NOT call any tool — so nothing happened " +
            "and the task did not progress. Do it NOW: emit the read_files (or run_command) tool call " +
            "in THIS response to gather what you need. If you ALREADY have enough context, write your " +
            "COMPLETE answer/plan instead. Do not just describe what you are about to do.",
        },
      ],
      formatCorrections: formatCorrections + 1,
      verifyRetries,
    };
  }

  // Genuine plain-text response = the model is done. Before finishing, run a FINAL verify of the
  // whole queued set (catches cross-edit breakage and any create_file content that no per-batch
  // check covered). If it fails and we still have budget, bounce the diagnostics back for one
  // more self-correction.
  let finalVerified: boolean | undefined = undefined;
  const finalEdits = await virtualEdits();
  if (finalEdits.length > 0) {
    const finalCheck = await validateProposedPatches({
      workspacePath,
      // direct mode already wrote edits to disk → verify the workspace as-is (empty edit set =
      // sandbox copy of current disk). sandbox mode applies the virtual tree.
      edits: directMode ? [] : finalEdits,
      loopCount,
      logger,
    });
    finalVerified = finalCheck.success;
    if (
      !finalCheck.success &&
      verifyRetries < MAX_VERIFY_RETRIES &&
      loopCount < maxTurns
    ) {
      logger.logInfo("[tools] final-verify failed — requesting self-correction", {
        attempt: verifyRetries + 1,
      });
      emitStatus(`🔁  [REI] Combined changes don't compile — asking the model to fix`);
      currentMessages.push(
        { role: "assistant", content },
        {
          role: "user",
          content:
            "Before finishing: your combined changes do NOT compile.\n" +
            `${finalCheck.feedback ?? "(no diagnostics)"}\n` +
            "Fix the affected file(s) with edit_file, then finish with a brief summary.",
        },
      );
      return {
        action: "continue",
        messages: currentMessages,
        formatCorrections,
        verifyRetries: verifyRetries + 1,
      };
    }
  }

  // Build the final user-facing response: recap-if-terse + "nothing changed" safety net.
  const finalResponse = await buildFinalResponse({
    content,
    firstTurnExplanation,
    modifiedFiles: [...virtualFiles.keys()],
    createdFiles,
    currentMessages,
    provider,
    modelOverride,
    formatCorrections,
    emitStatus,
  });

  return {
    action: "finalize",
    result: finalizeOutcome(
      logger,
      {
        response: appendCreatedSummary(finalResponse),
        validProposedPatches: finalEdits,
        verified: finalVerified,
      },
      finalEdits.length,
      finalEdits.length,
    ),
  };
}
