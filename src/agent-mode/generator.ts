import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { extractFileRequests, extractSREdits } from "./response-handler.js";
import {
  applyVirtualBatch,
  formatVirtualBatchResult,
} from "../tools/typescript-compile-check.js";
import { applyFileEdits } from "../tools/search-replace.js";
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
        details.push(
          `- ${file} edit #${idx + 1}: search block mismatch. Preview: "${preview}"`,
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
  const { provider, messagesForModel, workspacePath, logger } = params;

  let currentMessages = [...messagesForModel];
  let loopCount = 0;

  // Track last known state for failure recovery
  let lastRawResponse = "";
  let lastEdits: AgentSREdit[] = [];
  let lastValidationError = "";
  let consecutiveSearchMismatchFailures = 0;

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
      logger.logInfo(
        `Agent proposed ${edits.length} edits. Running virtual validation...`,
      );
      const valResult = await applyVirtualBatch(workspacePath, edits);

      if (!valResult.success) {
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
