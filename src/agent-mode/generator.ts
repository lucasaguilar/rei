import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { cleanResponseForHistory } from "../core/helpers/turn-message.helpers.js";
import {
  extractFileRequests,
  extractSREdits,
  extractWholeFileEdits,
  extractCommandRequests,
  extractToolCalls,
  formatSREditsForLog,
} from "./response-handler.js";
import { executeToolCallsFromResponse } from "../core/helpers/action-executor.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import {
  isDegenerate,
  buildCommandSignature,
  degenerateNotice,
} from "./helpers/loop-guard.js";
import {
  executeCommand,
  limitCommandOutput,
} from "../tools/command-executor.js";
import { startStepSpan } from "../telemetry/spans.js";
import { applyWholeFileBatchFS } from "../tools/patch-applier.js";
import {
  resolveVerifyCommand,
  runVerifyCommand,
} from "../tools/compile-check-core.js";

// Helper imports
import { findAdditionalCallerFiles } from "./helpers/contract-helper.js";
import {
  buildFileContextMessage,
  finalizeOutcome,
  handleCreateFileBlocks,
  validateProposedPatches,
  stripAllActionTags,
  generateXmlToolCallId,
  CREATED_FILES_MARKER,
  type ExecutionResult,
} from "./helpers/patch-helpers.js";
import { streamWithContinuation } from "./helpers/stream-with-continuation.js";
import { injectRequestedFiles } from "./helpers/inject-requested-files.js";
import { buildMaxTurnsFailureMessage } from "./helpers/max-turns-failure.js";
import { getMaxTurns } from "../config/model-runtime.js";

const MAX_TURNS = getMaxTurns();

export async function executeAgentTurn(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
  modelOverride?: string;
  onChunk?: (event: {
    type: "thinking" | "text" | "status";
    content: string;
  }) => void;
  /** Connected MCP registry — required for MCP <call_tool> dispatch. */
  mcpRegistry?: McpRegistry;
  /** Set of tool names (from ToolDefinition.modelFeedback === true) whose results
   *  must be fed back to the model. Everything else is fire-and-forget. */
  modelFeedbackTools?: Set<string>;
}): Promise<ExecutionResult> {
  const {
    provider,
    messagesForModel,
    workspacePath,
    scannedFiles,
    logger,
    modelOverride,
    onChunk,
    mcpRegistry,
    modelFeedbackTools,
  } = params;

  let currentMessages = [...messagesForModel];
  let loopCount = 0;
  // Files already shown to the model (path → content shown). Skips re-serving an unchanged
  // file on <request_files> — it's still in history, so re-reading just burns tokens.
  // (Parity with the native path's read dedup.)
  const alreadyProvided = new Map<string, string>();

  // Track last known state for failure recovery
  let lastRawResponse = "";
  let lastEdits: AgentSREdit[] = [];
  let lastValidationError = "";
  // Track search mismatch failures per file (not globally) to detect when a specific file
  // is stuck — after 2 consecutive failures in the same file, inject its full content.
  const searchMismatchByFile = new Map<string, number>();
  // Track consecutive identical validation errors → early termination after 3 identical failures
  let consecutiveIdenticalErrors = 0;
  let previousValidationError = "";
  let lastCmdSignature = "";
  const autoInjectedCallerFiles = new Set<string>();
  let firstTurnExplanation = "";
  // Accumulates files created via <create> across loop iterations so we can
  // surface them to the user (otherwise successful creates are invisible).
  const createdFiles: string[] = [];

  const getFinalResponse = (resp: string) => {
    let out = resp;
    if (
      loopCount > 1 &&
      firstTurnExplanation &&
      !resp.includes(firstTurnExplanation)
    ) {
      out = firstTurnExplanation + "\n\n" + resp;
    }
    if (createdFiles.length > 0) {
      const unique = [...new Set(createdFiles)];
      out +=
        `${CREATED_FILES_MARKER}${unique.length} file(s) created:[0m\n` +
        unique.map((f) => `- ${f}`).join("\n");
    }
    return out;
  };

  while (loopCount < MAX_TURNS) {
    loopCount++;

    // One `step-N` span per loop iteration (IP-3, agent XML/search-replace). Global-active so
    // the llm-call / tool spans created while this iteration runs nest under it.
    const endStep = startStepSpan(loopCount - 1);
    try {
      // 1. Ask the LLM. Each turn gets a FRESH 3-continuation truncation budget (start at 0) so a
      // truncated early turn doesn't starve later ones; streamWithContinuation bounds it internally.
      const { rawResponse } = await streamWithContinuation({
        provider,
        messages: currentMessages,
        modelOverride,
        onChunk,
        logger,
        truncationCount: 0,
      });

      lastRawResponse = rawResponse;
      logger.logInfo("Raw LLM Response", { rawResponse });

      // ── Degenerate response detection ──────────────────────────────────
      if (isDegenerate(rawResponse)) {
        logger.logInfo(
          "[loop-guard] Degenerate response detected in agent loop",
        );
        return finalizeOutcome(
          logger,
          {
            response:
              "⚠️ REI detected a degenerate response (the model entered a text generation loop). " +
              degenerateNotice(),
            validProposedPatches: [],
          },
          0,
          0,
        );
      }

      if (rawResponse.trim()) {
        if (loopCount === 1) {
          firstTurnExplanation = stripAllActionTags(rawResponse);
        }
      } else {
        logger.logInfo("Model returned empty response", { loopCount });
        if (loopCount < MAX_TURNS) {
          currentMessages.push({
            role: "assistant",
            content: cleanResponseForHistory(rawResponse),
          });
          currentMessages.push({
            role: "user",
            content:
              "Your previous response was empty. Reply with either plain text guidance or valid <edit>/<request_files> tags.",
          });
          continue;
        }

        return finalizeOutcome(
          logger,
          {
            response:
              "The model returned an empty response for this turn. Please retry or switch to a smaller/faster model.",
            validProposedPatches: [],
          },
          0,
          0,
        );
      }

      // 1a. Handle <create> blocks (file creation requests)
      const createOutcome = await handleCreateFileBlocks({
        rawResponse,
        workspacePath,
        logger,
      });
      createdFiles.push(...createOutcome.created);

      if (createOutcome.feedback) {
        currentMessages.push({
          role: "assistant",
          content: cleanResponseForHistory(rawResponse),
        });
        currentMessages.push({
          role: "user",
          content:
            createOutcome.feedback +
            "\nPlease fix these issues and reply with corrected <create> blocks or continue with the next step.",
        });
        continue;
      }

      // 2. Did the model request more files? (dedup unchanged files — still in history)
      const fileRequests = extractFileRequests(rawResponse);
      if (fileRequests.length > 0) {
        await injectRequestedFiles({
          fileRequests,
          rawResponse,
          workspacePath,
          currentMessages,
          logger,
          alreadyProvided,
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
          continue;
        }

        const valResult = await validateProposedPatches({
          workspacePath,
          edits,
          loopCount,
          logger,
        });

        if (!valResult.success) {
          lastValidationError = valResult.feedback || "Validation failed";
          const mismatchOnly = valResult.mismatchOnly;

          // Track search mismatch failures per file (not globally). If mismatchOnly, increment
          // counters for edited files; if compile error, reset them (different error type).
          const editedFiles = [...new Set(edits.map((e) => e.file))];
          if (mismatchOnly) {
            editedFiles.forEach((file) => {
              searchMismatchByFile.set(
                file,
                (searchMismatchByFile.get(file) ?? 0) + 1,
              );
            });
          } else {
            // Compile error (not search mismatch) → reset search mismatch counters
            editedFiles.forEach((file) => searchMismatchByFile.delete(file));
          }

          // Early termination: if the SAME validation error occurs 3+ times consecutively, the
          // model is stuck in a loop without making progress. Bail out instead of burning turns.
          if (
            lastValidationError === previousValidationError &&
            previousValidationError
          ) {
            consecutiveIdenticalErrors++;
            if (consecutiveIdenticalErrors >= 3) {
              logger.logInfo(
                `Early termination: identical validation error repeated ${consecutiveIdenticalErrors} times.`,
              );
              return finalizeOutcome(
                logger,
                {
                  response: buildMaxTurnsFailureMessage({
                    loopCount,
                    maxTurns: MAX_TURNS,
                    firstTurnExplanation,
                    lastValidationError:
                      `⚠️ Loop detected: the same validation error repeated ${consecutiveIdenticalErrors} times without progress.\n\n` +
                      lastValidationError,
                    failedEdits: lastEdits,
                  }),
                  validProposedPatches: [],
                  failed: true,
                  failedProposedPatches: lastEdits,
                  lastValidationError,
                },
                lastEdits.length,
                0,
              );
            }
          } else {
            consecutiveIdenticalErrors = 0;
          }
          previousValidationError = lastValidationError;

          if (loopCount < MAX_TURNS) {
            logger.logInfo(
              `Virtual validation failed. Feeding back errors (Turn ${loopCount}/${MAX_TURNS}).`,
            );
            currentMessages.push({
              role: "assistant",
              content: cleanResponseForHistory(rawResponse),
            });

            // Find files that failed search mismatch 2+ times → inject their content + suggest rewrite_file
            const stuckFiles = editedFiles.filter(
              (f) => (searchMismatchByFile.get(f) ?? 0) >= 2,
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
              continue;
            }

            // Compile errors in files the model hasn't edited yet — inject them immediately so the
            // model can write correct edits for ALL affected files in one response. Without the file
            // content the model has no way to know the exact search block to target, so it loops.
            const extraFiles = valResult.extraFilesNeeded ?? [];
            if (!mismatchOnly && extraFiles.length > 0) {
              const editedFileList = [
                ...new Set(edits.map((e) => e.file)),
              ].join(", ");
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
              continue;
            }

            currentMessages.push({
              role: "user",
              content: `${valResult.feedback}\nPlease fix these issues and reply with corrected <edit> tags.`,
            });
            continue;
          }

          logger.logInfo(
            `Max turns reached. Returning failed outcome with ${lastEdits.length} partial patches.`,
          );
          return finalizeOutcome(
            logger,
            {
              response: buildMaxTurnsFailureMessage({
                loopCount,
                maxTurns: MAX_TURNS,
                firstTurnExplanation,
                lastValidationError,
                failedEdits: lastEdits,
              }),
              validProposedPatches: [],
              failed: true,
              failedProposedPatches: lastEdits,
              lastValidationError,
            },
            lastEdits.length,
            0,
          );
        }

        // Reached only after validateProposedPatches succeeded above: the full edit
        // set compiled in the sandbox, so mark it explicitly verified (rather than
        // relying on the legacy "not failed" heuristic). Mirrors the tools path.
        return finalizeOutcome(
          logger,
          {
            response: getFinalResponse(rawResponse),
            validProposedPatches: edits,
            verified: true,
          },
          edits.length,
          edits.length,
        );
      }

      // 3b. Did the model request commands?
      const commands = extractCommandRequests(rawResponse);
      if (commands.length > 0) {
        // Command loop detection: only break when the same commands FAILED last time.
        // Successful repeated commands (e.g. a verification re-run) are allowed.
        const cmdSignature = buildCommandSignature(commands, [], []);
        if (cmdSignature && cmdSignature === lastCmdSignature) {
          logger.logInfo(
            "[loop-guard] Repeated command signature detected, breaking agent loop",
            { cmdSignature },
          );
          return finalizeOutcome(
            logger,
            {
              response:
                getFinalResponse(rawResponse) +
                "\n\n⚠️ REI detected a command loop — the model is repeating the same failing commands. " +
                "Stopping execution. Try asking it to explain the error instead of executing commands.",
              validProposedPatches: [],
            },
            0,
            0,
          );
        }

        let commandFeedback = "";
        let anyCommandFailed = false;
        for (const cmd of commands) {
          logger.logInfo(`Executing command: ${cmd}`);
          const cmdResult = await executeCommand(cmd, workspacePath);
          logger.logCommandExecution(cmd, cmdResult);
          if (!cmdResult.success) anyCommandFailed = true;
          const truncatedStdout = limitCommandOutput(
            cmdResult.stdout || "none",
          );
          const truncatedStderr = limitCommandOutput(
            cmdResult.stderr || "none",
          );
          commandFeedback +=
            `\nCommand: ${cmd}\nExit Code: ${cmdResult.exitCode}` +
            `\nStdout: ${truncatedStdout}\nStderr: ${truncatedStderr}\n`;
        }

        // Only arm the loop guard for this signature if at least one command failed.
        // If all succeeded, the model may legitimately re-run them for verification.
        lastCmdSignature = anyCommandFailed ? cmdSignature : "";

        if (loopCount < MAX_TURNS) {
          const cmdId = generateXmlToolCallId("execute_command");
          currentMessages.push({
            role: "assistant",
            content: cleanResponseForHistory(rawResponse),
            tool_calls: [
              {
                id: cmdId,
                type: "function",
                function: {
                  name: "execute_command",
                  arguments: JSON.stringify({ commands }),
                },
              },
            ],
          });
          currentMessages.push({
            role: "tool",
            tool_call_id: cmdId,
            name: "execute_command",
            content: commandFeedback,
          });
          continue;
        }

        return finalizeOutcome(
          logger,
          {
            response: getFinalResponse(
              rawResponse +
                "\n\n--- Command Execution Results ---\n" +
                commandFeedback,
            ),
            validProposedPatches: [],
          },
          0,
          0,
        );
      }

      // 3c. <call_tool> — dispatch and selectively re-feed model-feedback tools (e.g. MCP).
      // Fire-and-forget tools (weather, search) are executed but NOT re-fed to the model.
      const toolCalls = extractToolCalls(rawResponse);
      if (toolCalls.length > 0) {
        const hasFeedbackCall = toolCalls.some(
          (c) => modelFeedbackTools?.has(c.name) || c.name.startsWith("mcp:"),
        );
        const toolFeedback = await executeToolCallsFromResponse(
          rawResponse,
          provider,
          logger,
          mcpRegistry,
        );

        if (hasFeedbackCall && loopCount < MAX_TURNS) {
          const tcId = generateXmlToolCallId("call_tool");
          const toolNames = toolCalls.map((c) => c.name).join(",");
          currentMessages.push({
            role: "assistant",
            content: cleanResponseForHistory(rawResponse),
            tool_calls: [
              {
                id: tcId,
                type: "function",
                function: {
                  name: toolNames,
                  arguments: JSON.stringify(toolCalls.map((c) => c.args)),
                },
              },
            ],
          });
          currentMessages.push({
            role: "tool",
            tool_call_id: tcId,
            name: toolNames,
            content: toolFeedback,
          });
          continue;
        }
        // Fire-and-forget only, or at max turns: append result to response and return.
        return finalizeOutcome(
          logger,
          {
            response: getFinalResponse(
              stripAllActionTags(rawResponse) + toolFeedback,
            ),
            validProposedPatches: [],
          },
          0,
          0,
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
          response: getFinalResponse(rawResponse),
          validProposedPatches: [],
        },
        0,
        0,
      );
    } finally {
      endStep();
    }
  }

  // Loop exhausted without any edits (e.g. only file requests, model never produced patches)
  return finalizeOutcome(
    logger,
    {
      response: buildMaxTurnsFailureMessage({
        loopCount,
        maxTurns: MAX_TURNS,
        firstTurnExplanation,
        lastValidationError:
          lastValidationError ||
          "No edits were produced within the turn limit.",
        failedEdits: lastEdits,
      }),
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

export async function executeAgentTurnWholefile(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  logger: AgentLogger;
  modelOverride?: string;
  onChunk?: (event: {
    type: "thinking" | "text" | "status";
    content: string;
  }) => void;
  /** Connected MCP registry — required for MCP <call_tool> dispatch. */
  mcpRegistry?: McpRegistry;
  /** Set of tool names (from ToolDefinition.modelFeedback === true) whose results
   *  must be fed back to the model. Everything else is fire-and-forget. */
  modelFeedbackTools?: Set<string>;
}): Promise<ExecutionResult> {
  const {
    provider,
    messagesForModel,
    workspacePath,
    logger,
    modelOverride,
    onChunk,
    mcpRegistry,
    modelFeedbackTools,
  } = params;
  let currentMessages = [...messagesForModel];
  let loopCount = 0;
  let lastRawResponse = "";
  let firstTurnExplanation = "";

  const getFinalResponse = (resp: string) => {
    if (
      loopCount > 1 &&
      firstTurnExplanation &&
      !resp.includes(firstTurnExplanation)
    ) {
      return firstTurnExplanation + "\n\n" + resp;
    }
    return resp;
  };

  while (loopCount < MAX_TURNS) {
    loopCount++;

    // One `step-N` span per loop iteration (IP-3, agent whole-file). Global-active so the
    // llm-call / tool spans created while this iteration runs nest under it.
    const endStep = startStepSpan(loopCount - 1);
    try {
      // Each turn gets a FRESH 3-continuation truncation budget (start at 0) so a truncated early
      // turn doesn't starve later ones; streamWithContinuation bounds it internally.
      const { rawResponse } = await streamWithContinuation({
        provider,
        messages: currentMessages,
        modelOverride,
        onChunk,
        logger,
        truncationCount: 0,
      });

      lastRawResponse = rawResponse;
      logger.logInfo("Raw LLM Response (wholefile mode)", { rawResponse });

      if (rawResponse.trim()) {
        if (loopCount === 1) {
          firstTurnExplanation = stripAllActionTags(rawResponse);
        }
      } else {
        if (loopCount < MAX_TURNS) {
          currentMessages.push({
            role: "assistant",
            content: cleanResponseForHistory(rawResponse),
          });
          currentMessages.push({
            role: "user",
            content:
              "Your previous response was empty. Reply with plain text guidance or <wholefile> tags.",
          });
          continue;
        }
        return finalizeOutcome(
          logger,
          { response: "Empty response.", validProposedPatches: [] },
          0,
          0,
        );
      }

      // 1. <request_files> — inject file contents and continue (no dedup in wholefile mode)
      const fileRequests = extractFileRequests(rawResponse);
      if (fileRequests.length > 0) {
        await injectRequestedFiles({
          fileRequests,
          rawResponse,
          workspacePath,
          currentMessages,
          logger,
        });
        continue;
      }

      // 2. Extract all action blocks
      const wholefileEdits = extractWholeFileEdits(rawResponse);
      const commands = extractCommandRequests(rawResponse);

      // 3. Apply <wholefile> blocks if present
      if (wholefileEdits.length > 0) {
        logger.logInfo(
          `Agent proposed ${wholefileEdits.length} wholefile rewrite(s)`,
          { files: wholefileEdits.map((e) => e.file) },
        );

        const result = await applyWholeFileBatchFS(
          wholefileEdits,
          workspacePath,
        );
        const failed = result.results.filter((r) => !r.applied);

        if (failed.length > 0) {
          const feedback =
            "Some <wholefile> blocks failed to write:\n" +
            failed
              .map((r) => `- ${r.file}: ${r.validationErrors.join("; ")}`)
              .join("\n");
          if (loopCount < MAX_TURNS) {
            currentMessages.push({
              role: "assistant",
              content: cleanResponseForHistory(rawResponse),
            });
            currentMessages.push({
              role: "user",
              content: feedback + "\nPlease retry.",
            });
            continue;
          }
          return finalizeOutcome(
            logger,
            {
              response: getFinalResponse(rawResponse),
              validProposedPatches: [],
              failed: true,
            },
            wholefileEdits.length,
            0,
          );
        }

        const appliedFiles = result.results.map((r) => r.file);
        let summary =
          `\n\n---\n\u001b[32m\u001b[1m${wholefileEdits.length} file(s) written.\u001b[0m\n` +
          appliedFiles.map((f) => `- ${f}`).join("\n");

        // 4. Also execute any <execute_command> tags in the same response
        if (commands.length > 0) {
          summary += "\n\n--- Command Execution Results ---";
          for (const cmd of commands) {
            logger.logInfo(`Executing command: ${cmd}`);
            const cmdResult = await executeCommand(cmd, workspacePath);
            logger.logCommandExecution(cmd, cmdResult);
            const truncatedStdout = limitCommandOutput(
              cmdResult.stdout || "none",
            );
            const truncatedStderr = limitCommandOutput(
              cmdResult.stderr || "none",
            );
            summary +=
              `\nCommand: ${cmd}\nExit Code: ${cmdResult.exitCode}` +
              `\nStdout: ${truncatedStdout}\nStderr: ${truncatedStderr}`;
          }
        }

        // 5. Post-apply validation — always uses the project's full verify command.
        const skipValidate = process.env.REI_WHOLEFILE_SKIP_VALIDATE === "true";
        if (!skipValidate) {
          const verifyCmd = resolveVerifyCommand(workspacePath);
          const isAngularProject = verifyCmd.includes("ng build");

          logger.logInfo(`Running post-apply validation: ${verifyCmd}`);
          const verifyResult = await runVerifyCommand(workspacePath, verifyCmd);

          if (verifyResult.exitCode !== 0) {
            const errorOutput = [verifyResult.stderr, verifyResult.stdout]
              .filter(Boolean)
              .join("\n")
              .split("\n")
              .slice(0, 40)
              .join("\n");

            logger.logInfo("Post-apply validation failed", {
              verifyCmd,
              errorPreview: errorOutput.slice(0, 300),
            });

            if (!isAngularProject && loopCount < MAX_TURNS) {
              currentMessages.push({
                role: "assistant",
                content: cleanResponseForHistory(rawResponse),
              });
              currentMessages.push({
                role: "user",
                content:
                  `Files were written, but the project failed to compile.\n` +
                  `Verify command: \`${verifyCmd}\`\n\n` +
                  `Errors:\n\`\`\`\n${errorOutput}\n\`\`\`\n\n` +
                  `Please fix the errors and resubmit the corrected files using <wholefile> blocks.`,
              });
              continue;
            }

            summary += `\n\n\u001b[31m\u001b[1mValidation failed:\u001b[0m\n${errorOutput}`;
          } else {
            summary += `\n\u001b[32m✓ Validation passed (${verifyCmd.split(" ")[1] ?? verifyCmd})\u001b[0m`;
          }
        }

        return finalizeOutcome(
          logger,
          {
            response: getFinalResponse(rawResponse + summary),
            validProposedPatches: [],
          },
          wholefileEdits.length,
          wholefileEdits.length,
        );
      }

      // 5. Commands only (no wholefile) — execute and feed back for follow-up turn
      if (commands.length > 0) {
        let commandFeedback = "";
        for (const cmd of commands) {
          logger.logInfo(`Executing command: ${cmd}`);
          const cmdResult = await executeCommand(cmd, workspacePath);
          logger.logCommandExecution(cmd, cmdResult);
          const truncatedStdout = limitCommandOutput(
            cmdResult.stdout || "none",
          );
          const truncatedStderr = limitCommandOutput(
            cmdResult.stderr || "none",
          );
          commandFeedback +=
            `\nCommand: ${cmd}\nExit Code: ${cmdResult.exitCode}` +
            `\nStdout: ${truncatedStdout}\nStderr: ${truncatedStderr}\n`;
        }

        if (loopCount < MAX_TURNS) {
          const cmdId2 = generateXmlToolCallId("execute_command");
          currentMessages.push({
            role: "assistant",
            content: cleanResponseForHistory(rawResponse),
            tool_calls: [
              {
                id: cmdId2,
                type: "function",
                function: {
                  name: "execute_command",
                  arguments: JSON.stringify({ commands }),
                },
              },
            ],
          });
          currentMessages.push({
            role: "tool",
            tool_call_id: cmdId2,
            name: "execute_command",
            content: commandFeedback,
          });
          continue;
        }

        return finalizeOutcome(
          logger,
          {
            response: getFinalResponse(
              rawResponse +
                "\n\n--- Command Execution Results ---\n" +
                commandFeedback,
            ),
            validProposedPatches: [],
          },
          0,
          0,
        );
      }

      // 5b. <call_tool> — dispatch and selectively re-feed model-feedback tools (e.g. MCP).
      // Fire-and-forget tools (weather, search) are executed but NOT re-fed to the model.
      const toolCalls = extractToolCalls(rawResponse);
      if (toolCalls.length > 0) {
        const hasFeedbackCall = toolCalls.some(
          (c) => modelFeedbackTools?.has(c.name) || c.name.startsWith("mcp:"),
        );
        const toolFeedback = await executeToolCallsFromResponse(
          rawResponse,
          provider,
          logger,
          mcpRegistry,
        );

        if (hasFeedbackCall && loopCount < MAX_TURNS) {
          const tcId2 = generateXmlToolCallId("call_tool");
          const toolNames2 = toolCalls.map((c) => c.name).join(",");
          currentMessages.push({
            role: "assistant",
            content: cleanResponseForHistory(rawResponse),
            tool_calls: [
              {
                id: tcId2,
                type: "function",
                function: {
                  name: toolNames2,
                  arguments: JSON.stringify(toolCalls.map((c) => c.args)),
                },
              },
            ],
          });
          currentMessages.push({
            role: "tool",
            tool_call_id: tcId2,
            name: toolNames2,
            content: toolFeedback,
          });
          continue;
        }
        return finalizeOutcome(
          logger,
          {
            response: getFinalResponse(
              stripAllActionTags(rawResponse) + toolFeedback,
            ),
            validProposedPatches: [],
          },
          0,
          0,
        );
      }

      // 6. Plain text response — no action blocks found
      logger.logNoEditsReason("model_returned_text_only", {
        loopCount,
        rawResponsePreview: rawResponse.substring(0, 200),
      });
      // Cartel: the model produced edit-looking text (a code block, or a malformed/partial
      // <edit>/<create>) but nothing parsed into a real action, so NOTHING was applied. Warn
      // loudly so the user is never misled into thinking the change was made. (Parity with the
      // native path's "NO FILE WAS CHANGED" guard.)
      let textOnlyResponse = getFinalResponse(rawResponse);
      if (/```|<edit\b|<create\b|<wholefile\b/i.test(rawResponse)) {
        textOnlyResponse =
          `\x1b[1m\x1b[33m⚠️  NO FILE WAS CHANGED.\x1b[0m The model described an edit but did not ` +
          `emit a valid <edit>/<create> block, so nothing was applied to disk. Re-run or rephrase.\n\n` +
          textOnlyResponse;
      }
      return finalizeOutcome(
        logger,
        { response: textOnlyResponse, validProposedPatches: [] },
        0,
        0,
      );
    } finally {
      endStep();
    }
  }

  return finalizeOutcome(
    logger,
    {
      response: buildMaxTurnsFailureMessage({
        loopCount,
        maxTurns: MAX_TURNS,
        firstTurnExplanation,
        lastValidationError:
          "The agent loop exhausted all turns without writing files.",
        failedEdits: [],
      }),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}
