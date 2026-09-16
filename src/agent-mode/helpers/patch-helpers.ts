import type { ChatMessage } from "../../chat/types.js";
import * as fs from "fs/promises";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { TokenUsage } from "../../providers/model-provider.js";
import { applyCreateFileBatchFS } from "../../tools/patch-applier.js";
import {
  applyVirtualBatch,
  formatVirtualBatchResult,
  resolveReferencedFiles,
} from "../../tools/compile-check-factory.js";
import { applyFileEdits } from "../../tools/search-replace.js";
import { extractCreateFileRequests } from "../response-handler.js";
import { stripNativeToolSyntax } from "../../core/helpers/turn-message.helpers.js";
import { resolveWorkspacePath } from "../../workspace/file-security.js";

const SEARCH_MISMATCH_HINT = "Could not find exact match for search block in";

export interface ExecutionResult {
  response: string;
  validProposedPatches: AgentSREdit[];
  failed?: boolean;
  failedProposedPatches?: AgentSREdit[];
  lastValidationError?: string;
  /**
   * Whether the FINAL combined set of edits passed sandbox verification (the
   * verify command compiled the whole result). Distinct from per-batch checks:
   * a turn can have all batches individually pass yet the combined result fail.
   * Undefined → no explicit final verify ran; callers fall back to the legacy
   * "not failed && has patches" heuristic.
   */
  verified?: boolean;
  /** Aggregated token usage across all model calls in this turn (max prompt / sum completion). */
  usage?: TokenUsage;
  /**
   * The messages the loop APPENDED this turn: the assistant requests carrying `tool_calls` and the
   * results answering them. Returned so the caller can persist them instead of dropping them.
   *
   * Dropping them is what made every turn start cold. A local backend keeps the KV of the last
   * prompt and reuses it only while the next prompt EXTENDS it; removing the turn's tool traffic
   * from the middle leaves the next prompt diverging from what was cached, so the whole thing is
   * re-read. Measured on oMLX at ~23k tokens: 0.59s when the traffic stayed, 40.36s when it was
   * dropped — with a SMALLER prompt.
   */
  turnMessages?: ChatMessage[];
}

/** Marker prefixing the "N file(s) created" summary appended to a turn response. */
export const CREATED_FILES_MARKER = "\n\n---\n[32m[1m";

/**
 * Builds a system message injecting the contents of requested files.
 */
export async function buildFileContextMessage(
  workspacePath: string,
  files: string[],
): Promise<string> {
  const fileContents = [];
  for (const f of files) {
    const absPath = resolveWorkspacePath(f, workspacePath);
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
    const absPath = resolveWorkspacePath(file, workspacePath);
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
  // Prefer the explicit final-verify result; fall back to the legacy heuristic
  // only when no final verify ran (e.g. turns that produced no edits).
  const sandboxVerified =
    outcome.verified ?? (!outcome.failed && validCount > 0);

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

  return { ...outcome, verified: sandboxVerified };
}

/**
 * Parses and orchestrates application of <create> blocks, returning feedback if failed.
 */
export async function handleCreateFileBlocks(params: {
  rawResponse: string;
  workspacePath: string;
  logger: AgentLogger;
}): Promise<{ feedback: string | null; created: string[] }> {
  const { rawResponse, workspacePath, logger } = params;
  const createFileRequests = extractCreateFileRequests(rawResponse);
  if (createFileRequests.length === 0) return { feedback: null, created: [] };

  const createResults = await applyCreateFileBatchFS(
    createFileRequests,
    workspacePath,
  );
  logger.logInfo("File creation results", { createResults });

  const created = createResults.results
    .filter((r) => r.applied)
    .map((r) => r.file);

  const failedCreates = createResults.results.filter((r) => !r.applied);
  if (failedCreates.length > 0) {
    const feedback =
      "Some <create> blocks failed:\n" +
      failedCreates
        .map((r) => `- ${r.file}: ${r.validationErrors.join("; ")}`)
        .join("\n");
    logger.logInfo("File creation feedback", { feedback });
    return { feedback, created };
  }
  return { feedback: null, created };
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
  extraFilesNeeded: string[];
}> {
  const { workspacePath, edits, loopCount, logger } = params;
  const valResult = await applyVirtualBatch(workspacePath, edits);

  if (valResult.success) {
    return {
      success: true,
      feedback: null,
      mismatchOnly: false,
      applyErrors: [],
      extraFilesNeeded: [],
    };
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

  // Identify files referenced in compile errors that the model didn't include in its edit set.
  // These are dependency files that the model's edits broke — the model needs to see them to fix them.
  const editedFilePaths = new Set(edits.map((e) => e.file));
  const extraFilesNeeded = [
    ...new Set(
      [
        // Files where errors APPEAR that the model didn't edit (broke a consumer).
        ...valResult.diagnostics.map((d) => d.filePath),
        // Modules REFERENCED by errors in edited files (the provider side: a consumer
        // imports a symbol the model hasn't added there yet). Language-dispatched.
        ...resolveReferencedFiles(workspacePath, valResult.diagnostics),
      ].filter((f) => f && !editedFilePaths.has(f)),
    ),
  ];

  return {
    success: false,
    feedback,
    mismatchOnly,
    applyErrors: valResult.applyErrors,
    extraFilesNeeded,
  };
}

/**
 * Strips all agent-mode action blocks (edit, create, request_files, execute_command,
 * call_tool, wholefile) from a response string — plus the native function-call syntax
 * (tool_call, function) that tool-trained models sometimes leak as text on the XML path.
 * Used to extract the natural prose explanation from a response.
 */
export function stripAllActionTags(text: string): string {
  return stripNativeToolSyntax(text)
    .replace(
      /<(edit|create|request_files|execute_command|call_tool|wholefile)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .trim();
}

let _xmlToolSeq = 0;

/**
 * Generates a stable, unique ID for a synthetic XML tool call.
 * Used to pair role:"assistant" tool_calls with role:"tool" results
 * on the XML agent path (where the model emits tags instead of JSON function calls).
 */
export function generateXmlToolCallId(toolName: string): string {
  _xmlToolSeq = (_xmlToolSeq + 1) % 100000;
  return `xml_${toolName}_${_xmlToolSeq.toString().padStart(5, "0")}`;
}
