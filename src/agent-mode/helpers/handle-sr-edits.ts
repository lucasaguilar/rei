import type { ChatSession } from "../../chat/types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import type { FileMeta } from "../../workspace/workspace-scanner.js";
import { cleanResponseForHistory } from "../../core/helpers/turn-message.helpers.js";
import { formatSREditsForLog } from "../response-handler.js";
import { findAdditionalCallerFiles } from "./contract-helper.js";
import {
  buildFileContextMessage,
  finalizeOutcome,
  validateProposedPatches,
  type ExecutionResult,
} from "./patch-helpers.js";
import { buildMaxTurnsFailureMessage } from "./max-turns-failure.js";

/**
 * Mutable per-turn-loop state for the search/replace edit handler. The maps/set accumulate across
 * loop iterations; `lastEdits`/`lastValidationError` are also read by the caller AFTER the loop to
 * build the final failure message, so they live here rather than as the handler's return value.
 */
export interface SrEditState {
  /** Most recent parsed edits (surfaced as `failedProposedPatches` on a failure outcome). */
  lastEdits: AgentSREdit[];
  /** Most recent validation error feedback. */
  lastValidationError: string;
  /** The previous turn's validation error (to detect a stuck, repeating error). */
  previousValidationError: string;
  /** How many times the SAME validation error has repeated consecutively. */
  consecutiveIdenticalErrors: number;
  /** Per-file count of consecutive search-block mismatches (drives the rewrite_file escalation). */
  searchMismatchByFile: Map<string, number>;
  /** Caller files already injected for a contract change (so we inject each at most once). */
  autoInjectedCallerFiles: Set<string>;
}

export function createSrEditState(): SrEditState {
  return {
    lastEdits: [],
    lastValidationError: "",
    previousValidationError: "",
    consecutiveIdenticalErrors: 0,
    searchMismatchByFile: new Map<string, number>(),
    autoInjectedCallerFiles: new Set<string>(),
  };
}

/** Either re-enter the loop (feedback/context was queued) or finish with this ExecutionResult. */
export type SrEditOutcome =
  | { action: "continue" }
  | { action: "finalize"; result: ExecutionResult };

/**
 * Handles a turn where the model proposed `<edit>` (search/replace) blocks, for the XML agent path.
 * In order: inject caller files for contract changes → sandbox-validate the edits → on failure feed
 * back targeted diagnostics (stuck-file rewrite_file escalation, broken-dependency injection, or a
 * generic retry), with early termination on a repeating error and a max-turns failure outcome → on
 * success finalize as verified. Mutates `state` and pushes to `currentMessages`. Extracted from
 * executeAgentTurn (Phase 3) — behavior-preserving.
 */
export async function handleSrEdits(params: {
  edits: AgentSREdit[];
  rawResponse: string;
  workspacePath: string;
  scannedFiles: FileMeta[];
  loopCount: number;
  maxTurns: number;
  logger: AgentLogger;
  currentMessages: ChatSession["messages"];
  firstTurnExplanation: string;
  getFinalResponse: (resp: string) => string;
  state: SrEditState;
}): Promise<SrEditOutcome> {
  const {
    edits,
    rawResponse,
    workspacePath,
    scannedFiles,
    loopCount,
    maxTurns,
    logger,
    currentMessages,
    firstTurnExplanation,
    getFinalResponse,
    state,
  } = params;

  state.lastEdits = edits;
  const previews = formatSREditsForLog(edits);
  logger.logSREditsParsed({
    turnLoop: loopCount,
    count: edits.length,
    files: [...new Set(edits.map((edit) => edit.file))],
    previews,
  });
  logger.logInfo(
    `Agent proposed ${edits.length} edits. Running sandbox validation...`,
    { previews },
  );

  const { callerFiles, changedSymbols } = findAdditionalCallerFiles({
    workspacePath,
    scannedFiles,
    edits,
    alreadyInjectedFiles: state.autoInjectedCallerFiles,
  });

  if (callerFiles.length > 0) {
    callerFiles.forEach((file) => state.autoInjectedCallerFiles.add(file));
    logger.logInfo(
      `Auto-injecting caller context for contract changes: ${callerFiles.join(", ")}`,
      { changedSymbols },
    );
    const contextMessage = await buildFileContextMessage(
      workspacePath,
      callerFiles,
    );

    currentMessages.push({
      role: "assistant",
      content: cleanResponseForHistory(rawResponse),
    });
    currentMessages.push({
      role: "user",
      content:
        `Your proposed edits change public method or function contracts (${changedSymbols.join(", ")}). ` +
        `You must update known consumers before finalizing the patch.\n\n` +
        `Here are caller files that reference those symbols:\n${contextMessage}\n\n` +
        `Please reply with a complete set of corrected <edit> tags covering both the declaration changes and all affected consumers.`,
    });
    return { action: "continue" };
  }

  const valResult = await validateProposedPatches({
    workspacePath,
    edits,
    loopCount,
    logger,
  });

  if (!valResult.success) {
    state.lastValidationError = valResult.feedback || "Validation failed";
    const mismatchOnly = valResult.mismatchOnly;

    // Track search mismatch failures per file (not globally). If mismatchOnly, increment
    // counters for edited files; if compile error, reset them (different error type).
    const editedFiles = [...new Set(edits.map((e) => e.file))];
    if (mismatchOnly) {
      editedFiles.forEach((file) => {
        state.searchMismatchByFile.set(
          file,
          (state.searchMismatchByFile.get(file) ?? 0) + 1,
        );
      });
    } else {
      // Compile error (not search mismatch) → reset search mismatch counters
      editedFiles.forEach((file) => state.searchMismatchByFile.delete(file));
    }

    // Early termination: if the SAME validation error occurs 3+ times consecutively, the
    // model is stuck in a loop without making progress. Bail out instead of burning turns.
    if (
      state.lastValidationError === state.previousValidationError &&
      state.previousValidationError
    ) {
      state.consecutiveIdenticalErrors++;
      if (state.consecutiveIdenticalErrors >= 3) {
        logger.logInfo(
          `Early termination: identical validation error repeated ${state.consecutiveIdenticalErrors} times.`,
        );
        return {
          action: "finalize",
          result: finalizeOutcome(
            logger,
            {
              response: buildMaxTurnsFailureMessage({
                loopCount,
                maxTurns,
                firstTurnExplanation,
                lastValidationError:
                  `⚠️ Loop detected: the same validation error repeated ${state.consecutiveIdenticalErrors} times without progress.\n\n` +
                  state.lastValidationError,
                failedEdits: state.lastEdits,
              }),
              validProposedPatches: [],
              failed: true,
              failedProposedPatches: state.lastEdits,
              lastValidationError: state.lastValidationError,
            },
            state.lastEdits.length,
            0,
          ),
        };
      }
    } else {
      state.consecutiveIdenticalErrors = 0;
    }
    state.previousValidationError = state.lastValidationError;

    if (loopCount < maxTurns) {
      logger.logInfo(
        `Virtual validation failed. Feeding back errors (Turn ${loopCount}/${maxTurns}).`,
      );
      currentMessages.push({
        role: "assistant",
        content: cleanResponseForHistory(rawResponse),
      });

      // Find files that failed search mismatch 2+ times → inject their content + suggest rewrite_file
      const stuckFiles = editedFiles.filter(
        (f) => (state.searchMismatchByFile.get(f) ?? 0) >= 2,
      );
      if (stuckFiles.length > 0) {
        logger.logInfo(
          `Auto-injecting file context after repeated search mismatches in: ${stuckFiles.join(", ")}`,
        );
        const contextMessage = await buildFileContextMessage(
          workspacePath,
          stuckFiles,
        );
        currentMessages.push({
          role: "user",
          content:
            `${valResult.feedback}\n\n` +
            `The <search> blocks for [${stuckFiles.join(", ")}] failed to match 2+ times. ` +
            `Here are the full file contents:\n${contextMessage}\n\n` +
            `**Recommendation:** Use \`rewrite_file\` for these files instead of \`edit_file\` — ` +
            `it doesn't require exact search matching and will overwrite the entire file.\n\n` +
            `Please reply with corrected edits.`,
        });
        return { action: "continue" };
      }

      // Compile errors in files the model hasn't edited yet — inject them immediately so the
      // model can write correct edits for ALL affected files in one response. Without the file
      // content the model has no way to know the exact search block to target, so it loops.
      const extraFiles = valResult.extraFilesNeeded ?? [];
      if (!mismatchOnly && extraFiles.length > 0) {
        const editedFileList = [...new Set(edits.map((e) => e.file))].join(", ");
        logger.logInfo(
          `Auto-injecting broken dependency files: ${extraFiles.join(", ")}`,
        );
        const contextMessage = await buildFileContextMessage(
          workspacePath,
          extraFiles,
        );
        currentMessages.push({
          role: "user",
          content:
            `${valResult.feedback}\n\n` +
            `Your edits to [${editedFileList}] broke the following files that you haven't edited yet. ` +
            `You MUST fix ALL broken files in a SINGLE response — do not split them across turns.\n\n` +
            `Here are the files that need updating:\n${contextMessage}\n` +
            `Reply with a COMPLETE set of <edit> tags covering BOTH your original changes AND all broken files.`,
        });
        return { action: "continue" };
      }

      currentMessages.push({
        role: "user",
        content: `${valResult.feedback}\nPlease fix these issues and reply with corrected <edit> tags.`,
      });
      return { action: "continue" };
    }

    logger.logInfo(
      `Max turns reached. Returning failed outcome with ${state.lastEdits.length} partial patches.`,
    );
    return {
      action: "finalize",
      result: finalizeOutcome(
        logger,
        {
          response: buildMaxTurnsFailureMessage({
            loopCount,
            maxTurns,
            firstTurnExplanation,
            lastValidationError: state.lastValidationError,
            failedEdits: state.lastEdits,
          }),
          validProposedPatches: [],
          failed: true,
          failedProposedPatches: state.lastEdits,
          lastValidationError: state.lastValidationError,
        },
        state.lastEdits.length,
        0,
      ),
    };
  }

  // Reached only after validateProposedPatches succeeded above: the full edit set compiled in the
  // sandbox, so mark it explicitly verified (rather than relying on the legacy "not failed"
  // heuristic). Mirrors the tools path.
  return {
    action: "finalize",
    result: finalizeOutcome(
      logger,
      {
        response: getFinalResponse(rawResponse),
        validProposedPatches: edits,
        verified: true,
      },
      edits.length,
      edits.length,
    ),
  };
}
