import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { AgentLogger } from "../core/logger.js";
import { cleanResponseForHistory } from "../core/helpers/turn-message.helpers.js";
import {
  extractFileRequests,
  extractSREdits,
  extractWholeFileEdits,
  extractCommandRequests,
  extractToolCalls,
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
import {
  finalizeOutcome,
  handleCreateFileBlocks,
  stripAllActionTags,
  generateXmlToolCallId,
  CREATED_FILES_MARKER,
  type ExecutionResult,
} from "./helpers/patch-helpers.js";
import { streamWithContinuation } from "./helpers/stream-with-continuation.js";
import { injectRequestedFiles } from "./helpers/inject-requested-files.js";
import { buildMaxTurnsFailureMessage } from "./helpers/max-turns-failure.js";
import {
  handleSrEdits,
  createSrEditState,
} from "./helpers/handle-sr-edits.js";
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
  let lastCmdSignature = "";
  // Search/replace edit-handling state (last edits, validation-error streaks, per-file search
  // mismatches, injected caller files). Mutated by handleSrEdits; lastEdits/lastValidationError are
  // also read below to build the loop-exhausted failure message.
  const srState = createSrEditState();
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
        const outcome = await handleSrEdits({
          edits,
          rawResponse,
          workspacePath,
          scannedFiles,
          loopCount,
          maxTurns: MAX_TURNS,
          logger,
          currentMessages,
          firstTurnExplanation,
          getFinalResponse,
          state: srState,
        });
        if (outcome.action === "finalize") return outcome.result;
        continue;
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
          srState.lastValidationError ||
          "No edits were produced within the turn limit.",
        failedEdits: srState.lastEdits,
      }),
      validProposedPatches: [],
      failed: true,
      failedProposedPatches: srState.lastEdits,
      lastValidationError:
        srState.lastValidationError ||
        "No edits were produced within the turn limit.",
    },
    srState.lastEdits.length,
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
