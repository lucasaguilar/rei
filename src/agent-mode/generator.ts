import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import {
  extractFileRequests,
  extractSREdits,
  formatSREditsForLog,
} from "./response-handler.js";
import {
  applyVirtualBatch,
  formatVirtualBatchResult,
} from "../tools/typescript-compile-check.js";
import { applyFileEdits } from "../tools/search-replace.js";
import { findSymbolCallers, rankCallerFiles } from "../context/caller-graph.js";
import * as fs from "fs/promises";
import * as path from "path";

export interface AgentModeOutcome {
  response: string;
  validProposedPatches: AgentSREdit[];
  failed?: boolean;
  failedProposedPatches?: AgentSREdit[];
  lastValidationError?: string;
}

const MAX_TURNS = 7;
const SEARCH_MISMATCH_HINT = "Could not find exact match for search block in";
const MAX_AUTO_INJECTED_CALLER_FILES = 5;

/**
 * Builds a system message injecting the contents of requested files.
 */
async function buildFileContextMessage(
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

function isSearchMismatchOnly(applyErrors: string[]): boolean {
  return (
    applyErrors.length > 0 &&
    applyErrors.every((error) => error.includes(SEARCH_MISMATCH_HINT))
  );
}

function extractPublicContractSignatures(block: string): Map<string, string> {
  const signatures = new Map<string, string>();
  const lines = block.split("\n");

  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;

    const publicMethod = normalized.match(
      /^public\s+(?:static\s+)?(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)/,
    );
    if (publicMethod) {
      signatures.set(publicMethod[1], normalized.replace(/\s+/g, " "));
      continue;
    }

    const exportedFunction = normalized.match(
      /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)/,
    );
    if (exportedFunction) {
      signatures.set(exportedFunction[1], normalized.replace(/\s+/g, " "));
    }
  }

  return signatures;
}

function detectContractChangeSymbols(edits: AgentSREdit[]): string[] {
  const changedSymbols = new Set<string>();

  for (const edit of edits) {
    const before = extractPublicContractSignatures(edit.search);
    const after = extractPublicContractSignatures(edit.replace);

    for (const [symbol, beforeSig] of before) {
      const afterSig = after.get(symbol);
      if (!afterSig || afterSig !== beforeSig) {
        changedSymbols.add(symbol);
      }
    }

    for (const symbol of after.keys()) {
      if (!before.has(symbol)) {
        changedSymbols.add(symbol);
      }
    }
  }

  return [...changedSymbols];
}

function findAdditionalCallerFiles(params: {
  workspacePath: string;
  scannedFiles: FileMeta[];
  edits: AgentSREdit[];
  alreadyInjectedFiles: Set<string>;
}): { callerFiles: string[]; changedSymbols: string[] } {
  const { workspacePath, scannedFiles, edits, alreadyInjectedFiles } = params;
  const changedSymbols = detectContractChangeSymbols(edits);
  if (changedSymbols.length === 0) {
    return { callerFiles: [], changedSymbols };
  }

  const editedFiles = new Set(edits.map((edit) => edit.file));
  const refs = findSymbolCallers({
    workspacePath,
    symbolNames: changedSymbols,
    scannedFiles,
    maxResults: 40,
  });

  const callerFiles = rankCallerFiles(refs)
    .filter(
      (filePath) =>
        !editedFiles.has(filePath) && !alreadyInjectedFiles.has(filePath),
    )
    .slice(0, MAX_AUTO_INJECTED_CALLER_FILES);

  return { callerFiles, changedSymbols };
}

async function buildPerEditMismatchDetails(
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
        // Incluir el searchPreview directamente en el mensaje de feedback
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

function finalizeOutcome(
  logger: AgentLogger,
  outcome: AgentModeOutcome,
  generatedPatchCount: number,
  appliedPatchCount: number,
): AgentModeOutcome {
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

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
}): Promise<AgentModeOutcome> {
  const { provider, messagesForModel, workspacePath, scannedFiles, logger } =
    params;

  let currentMessages = [...messagesForModel];
  let loopCount = 0;

  // Track last known state for failure recovery
  let lastRawResponse = "";
  let lastEdits: AgentSREdit[] = [];
  let lastValidationError = "";
  let consecutiveSearchMismatchFailures = 0;
  const autoInjectedCallerFiles = new Set<string>();

  while (loopCount < MAX_TURNS) {
    loopCount++;

    // 1. Ask the LLM
    const rawResponse = await provider.completeChat(currentMessages);
    lastRawResponse = rawResponse;
    logger.logInfo("Raw LLM Response", { rawResponse });

    // 2. Did the model request more files?
    const fileRequests = extractFileRequests(rawResponse);
    if (fileRequests.length > 0) {
      logger.logInfo(`Agent requested files: ${fileRequests.join(", ")}`);
      const contextMessage = await buildFileContextMessage(
        workspacePath,
        fileRequests,
      );

      currentMessages.push({ role: "assistant", content: rawResponse });
      currentMessages.push({
        role: "user",
        content: `Here are the requested files:\n${contextMessage}\nPlease continue your task.`,
      });
      continue;
    }

    // 3. Did the model provide edits?
    const edits = extractSREdits(rawResponse);
    if (edits.length > 0) {
      lastEdits = edits;
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
        alreadyInjectedFiles: autoInjectedCallerFiles,
      });

      if (callerFiles.length > 0) {
        callerFiles.forEach((file) => autoInjectedCallerFiles.add(file));
        logger.logInfo(
          `Auto-injecting caller context for contract changes: ${callerFiles.join(", ")}`,
          { changedSymbols },
        );
        const contextMessage = await buildFileContextMessage(
          workspacePath,
          callerFiles,
        );

        currentMessages.push({ role: "assistant", content: rawResponse });
        currentMessages.push({
          role: "user",
          content:
            `Your proposed edits change public method or function contracts (${changedSymbols.join(", ")}). ` +
            `You must update known consumers before finalizing the patch.\n\n` +
            `Here are caller files that reference those symbols:\n${contextMessage}\n\n` +
            `Please reply with a complete set of corrected <edit> tags covering both the declaration changes and all affected consumers.`,
        });
        continue;
      }

      const valResult = await applyVirtualBatch(workspacePath, edits);

      if (!valResult.success) {
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

        // Agregar resumen estructurado al log de información
        logger.logInfo("Validation failed summary", {
          errorKind,
          filesAffected: files,
          diagnosticsCount: valResult.diagnostics.length,
          applyErrorCount: valResult.applyErrors.length,
        });

        let feedback = formatVirtualBatchResult(valResult);
        const mismatchOnly = isSearchMismatchOnly(valResult.applyErrors);
        consecutiveSearchMismatchFailures = mismatchOnly
          ? consecutiveSearchMismatchFailures + 1
          : 0;

        if (mismatchOnly) {
          const details = await buildPerEditMismatchDetails(
            workspacePath,
            edits,
          );
          if (details.length > 0) {
            feedback +=
              "\n\nDetailed search mismatch report:\n" + details.join("\n");
          }
        }

        lastValidationError = feedback;

        if (loopCount < MAX_TURNS) {
          // Feed the errors back to the model for an auto-fix
          logger.logInfo(
            `Virtual validation failed. Feeding back errors (Turn ${loopCount}/${MAX_TURNS}).`,
          );
          currentMessages.push({ role: "assistant", content: rawResponse });

          if (consecutiveSearchMismatchFailures >= 2) {
            const requestedFiles = [...new Set(edits.map((edit) => edit.file))];
            logger.logInfo(
              `Auto-injecting file context after repeated search mismatches: ${requestedFiles.join(", ")}`,
            );
            const contextMessage = await buildFileContextMessage(
              workspacePath,
              requestedFiles,
            );
            currentMessages.push({
              role: "user",
              content:
                `${feedback}\n\n` +
                `The previous <search> blocks did not match exact file content. ` +
                `Here are the full files to patch accurately:\n${contextMessage}\n` +
                `Please reply with corrected <edit> tags.`,
            });
            continue;
          }

          currentMessages.push({
            role: "user",
            content: `${feedback}\nPlease fix these issues and reply with corrected <edit> tags.`,
          });
          continue;
        }

        // MAX_TURNS exhausted — return failed outcome with last known patches
        logger.logInfo(
          `Max turns reached. Returning failed outcome with ${lastEdits.length} partial patches.`,
        );
        return finalizeOutcome(
          logger,
          {
            response: lastRawResponse,
            validProposedPatches: [],
            failed: true,
            failedProposedPatches: lastEdits,
            lastValidationError,
          },
          lastEdits.length,
          0,
        );
      }

      // Success — return the valid edits
      return finalizeOutcome(
        logger,
        {
          response: rawResponse,
          validProposedPatches: edits,
        },
        edits.length,
        edits.length,
      );
    }

    // 4. Simple text response — no edits, no file requests
    logger.logNoEditsReason("model_returned_text_only", {
      loopCount,
      rawResponsePreview: rawResponse.substring(0, 200) + "...",
    });
    return finalizeOutcome(
      logger,
      {
        response: rawResponse,
        validProposedPatches: [],
      },
      0,
      0,
    );
  }

  // Loop exhausted without any edits (e.g. only file requests)
  return finalizeOutcome(
    logger,
    {
      response:
        lastRawResponse ||
        "Agent loop exceeded maximum turns without producing edits.",
      validProposedPatches: [],
      failed: true,
      failedProposedPatches: lastEdits,
      lastValidationError:
        lastValidationError || "No edits were produced within the turn limit.",
    },
    lastEdits.length,
    0,
  );
}

export function prepareAgentContext(): any {
  // Deprecated shell function, kept to avoid circular/import crashes temporarily
  // if run-chat references this directly.
  return {};
}

export function buildAgentFinalResponse(answer: string): any {
  // Same as above.
  return {
    response: answer,
    validProposedPatches: [],
  };
}
