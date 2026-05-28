import * as fs from "fs/promises";
import * as path from "path";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import type { AgentLogger } from "../../core/logger.js";
import { applyCreateFileBatchFS } from "../../tools/patch-applier.js";
import {
  applyVirtualBatch,
  formatVirtualBatchResult,
} from "../../tools/compile-check-factory.js";
import { applyFileEdits } from "../../tools/search-replace.js";
import { extractCreateFileRequests } from "../response-handler.js";

const SEARCH_MISMATCH_HINT = "Could not find exact match for search block in";

export interface ExecutionResult {
  response: string;
  validProposedPatches: AgentSREdit[];
  failed?: boolean;
  failedProposedPatches?: AgentSREdit[];
  lastValidationError?: string;
}

/**
 * Builds a system message injecting the contents of requested files.
 */
export async function buildFileContextMessage(
  workspacePath: string,
  files: string[],
): Promise<string> {
  const fileContents = [];
  for (const f of files) {
    const absPath = path.join(workspacePath, f);
    try {
      const content = await fs.readFile(absPath, "utf-8");
      fileContents.push(`--- File: ${f} ---\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      fileContents.push(
        `--- File: ${f} ---\n(Could not read file, it may not exist)`,
      );
    }
  }
  return "\n" + fileContents.join("\n\n");
}

export function isSearchMismatchOnly(applyErrors: string[]): boolean {
  return (
    applyErrors.length > 0 &&
    applyErrors.every((error) => error.includes(SEARCH_MISMATCH_HINT))
  );
}

/**
 * Details exact line mismatch locations on a per-edit level.
 */
export async function buildPerEditMismatchDetails(
  workspacePath: string,
  edits: AgentSREdit[],
): Promise<string[]> {
  const details: string[] = [];
  const byFile = new Map<string, AgentSREdit[]>();

  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }

  for (const [file, fileEdits] of byFile) {
    const absPath = path.join(workspacePath, file);
    let text: string;
    try {
      text = await fs.readFile(absPath, "utf-8");
    } catch {
      details.push(`- ${file}: file not found in workspace.`);
      continue;
    }

    for (let idx = 0; idx < fileEdits.length; idx += 1) {
      const edit = fileEdits[idx];
      const res = applyFileEdits(text, [edit]);
      if (!res.success) {
        const preview = edit.search
          .split("\n")
          .slice(0, 2)
          .join(" ")
          .slice(0, 140);
        details.push(
          `- ${file} edit #${idx + 1}: search block mismatch. Search preview: "${preview}"`,
        );
      } else if (res.newContent) {
        text = res.newContent;
      }
    }
  }

  return details;
}

/**
 * Finalizes turn metrics and logs outcomes.
 */
export function finalizeOutcome(
  logger: AgentLogger,
  outcome: ExecutionResult,
  generatedPatchCount: number,
  appliedPatchCount: number,
): ExecutionResult {
  const validCount = outcome.validProposedPatches.length;
  const failedCount = outcome.failedProposedPatches?.length ?? 0;
  const rejectedCount = Math.max(0, generatedPatchCount - validCount);
  const sandboxVerified = !outcome.failed && validCount > 0;

  logger.logPatchOutcome({
    validCount,
    rejectedCount,
    sandboxVerified,
    confirmableCount: validCount,
  });
  logger.logPatchQuality({
    ideaDetected: generatedPatchCount > 0,
    patchGenerated: generatedPatchCount > 0,
    patchApplicable: validCount > 0 || failedCount > 0,
    patchCompilable: sandboxVerified,
    generatedPatchCount,
    appliedPatchCount,
  });

  return outcome;
}

/**
 * Parses and orchestrates application of <create> blocks, returning feedback if failed.
 */
export async function handleCreateFileBlocks(params: {
  rawResponse: string;
  workspacePath: string;
  logger: AgentLogger;
}): Promise<string | null> {
  const { rawResponse, workspacePath, logger } = params;
  const createFileRequests = extractCreateFileRequests(rawResponse);
  if (createFileRequests.length === 0) return null;

  const createResults = await applyCreateFileBatchFS(
    createFileRequests,
    workspacePath,
  );
  logger.logInfo("File creation results", { createResults });

  const failedCreates = createResults.results.filter((r) => !r.applied);
  if (failedCreates.length > 0) {
    const feedback =
      "Some <create> blocks failed:\n" +
      failedCreates
        .map((r) => `- ${r.file}: ${r.validationErrors.join("; ")}`)
        .join("\n");
    logger.logInfo("File creation feedback", { feedback });
    return feedback;
  }
  return null;
}

/**
 * Runs batch patch virtual sandbox verification and compiles detailed feedback.
 */
export async function validateProposedPatches(params: {
  workspacePath: string;
  edits: AgentSREdit[];
  loopCount: number;
  logger: AgentLogger;
}): Promise<{
  success: boolean;
  feedback: string | null;
  mismatchOnly: boolean;
  applyErrors: string[];
}> {
  const { workspacePath, edits, loopCount, logger } = params;
  const valResult = await applyVirtualBatch(workspacePath, edits);

  if (valResult.success) {
    return { success: true, feedback: null, mismatchOnly: false, applyErrors: [] };
  }

  const files = [...new Set(edits.map((edit) => edit.file))];
  const errorKind =
    valResult.applyErrors.length > 0 && valResult.diagnostics.length > 0
      ? "mixed"
      : valResult.applyErrors.length > 0
        ? "apply"
        : "compile";

  logger.logSRValidationFailed({
    turnLoop: loopCount,
    errorKind,
    editCount: edits.length,
    files,
    applyErrors: [
      ...valResult.applyErrors,
      ...(valResult.verifyStderr
        ? [
            `verifyCommand=${valResult.verifyCommand}`,
            ...valResult.verifyStderr.split("\n").slice(0, 5),
          ]
        : []),
    ],
    diagnostics: valResult.diagnostics.map((d) => ({
      filePath: d.filePath,
      line: d.line,
      column: d.column,
      code: d.code,
      message: d.message,
    })),
  });

  logger.logInfo("Validation failed summary", {
    errorKind,
    filesAffected: files,
    diagnosticsCount: valResult.diagnostics.length,
    applyErrorCount: valResult.applyErrors.length,
  });

  let feedback = formatVirtualBatchResult(workspacePath, valResult);
  const mismatchOnly = isSearchMismatchOnly(valResult.applyErrors);

  if (mismatchOnly) {
    const details = await buildPerEditMismatchDetails(workspacePath, edits);
    if (details.length > 0) {
      feedback += "\n\nDetailed search mismatch report:\n" + details.join("\n");
    }
  }

  return {
    success: false,
    feedback,
    mismatchOnly,
    applyErrors: valResult.applyErrors,
  };
}

/**
 * Strips all agent-mode action blocks (edit, create, request_files, execute_command, call_tool, wholefile) from a response string.
 * Used to extract the natural prose explanation from the first turn.
 */
export function stripAllActionTags(text: string): string {
  return text
    .replace(/<(edit|create|request_files|execute_command|call_tool|wholefile)\b[\s\S]*?<\/\1>/gi, "")
    .trim();
}
