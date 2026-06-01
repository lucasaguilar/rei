import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { stripThinkingBlock } from "../core/helpers/turn-message.helpers.js";
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
import { isDegenerate, buildCommandSignature } from "./helpers/loop-guard.js";
import { executeCommand, limitCommandOutput } from "../tools/command-executor.js";
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
  type ExecutionResult,
} from "./helpers/patch-helpers.js";
import { streamTurnWithInterception } from "./helpers/token-streamer.js";

const MAX_TURNS = process.env.REI_MAX_TURNS ? parseInt(process.env.REI_MAX_TURNS, 10) : 7;

/** Max consecutive truncation continuations before giving up. */
const MAX_TRUNCATION_CONTINUATIONS = 3;

/**
 * Builds a human-readable failure report when the agent loop exhausts MAX_TURNS
 * without producing valid edits. Explains what happened and gives actionable suggestions.
 */
function buildMaxTurnsFailureMessage(params: {
  loopCount: number;
  firstTurnExplanation: string;
  lastValidationError: string;
  failedEdits: AgentSREdit[];
}): string {
  const { loopCount, firstTurnExplanation, lastValidationError, failedEdits } = params;

  const lines: string[] = [
    `⚠️ REI could not complete the task after ${loopCount} attempts.`,
    "",
  ];

  if (firstTurnExplanation) {
    lines.push("**What was planned:**");
    lines.push(firstTurnExplanation);
    lines.push("");
  }

  if (lastValidationError) {
    lines.push("**Why it failed:**");
    lines.push(lastValidationError);
    lines.push("");
  }

  if (failedEdits.length > 0) {
    const files = [...new Set(failedEdits.map((e) => e.file))];
    lines.push(`**Files involved:** ${files.join(", ")}`);
    lines.push("");
  }

  lines.push("**What to try next:**");
  lines.push("- Ask REI to re-read the files first: *\"Read [file] and retry\"*");
  lines.push("- Switch to wholefile mode: set `AGENT_EDIT_FORMAT=wholefile` in your .env");
  if (loopCount >= MAX_TURNS) {
    lines.push(`- Increase the turn limit: set \`REI_MAX_TURNS=${MAX_TURNS + 3}\` in your .env`);
  }

  return lines.join("\n");
}

/** Injected when the model's previous response was cut off by the token limit. */
const TRUNCATION_CONTINUATION =
  "Your previous response was cut off by the output token limit. " +
  "Continue EXACTLY from where you left off — do NOT repeat, summarize, or restart. " +
  "Just continue the text as one uninterrupted response.";

export async function executeAgentTurn(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
  modelOverride?: string;
  onChunk?: (event: { type: "thinking" | "text" | "status"; content: string }) => void;
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
  let truncationCount = 0;

  // Track last known state for failure recovery
  let lastRawResponse = "";
  let lastEdits: AgentSREdit[] = [];
  let lastValidationError = "";
  let consecutiveSearchMismatchFailures = 0;
  let lastCmdSignature = "";
  const autoInjectedCallerFiles = new Set<string>();
  let firstTurnExplanation = "";

  const getFinalResponse = (resp: string) => {
    if (loopCount > 1 && firstTurnExplanation && !resp.includes(firstTurnExplanation)) {
      return firstTurnExplanation + "\n\n" + resp;
    }
    return resp;
  };

  while (loopCount < MAX_TURNS) {
    loopCount++;

    // 1. Ask the LLM — accumulate continuations if truncated
    let finishReason = "stop";
    let rawResponse = await streamTurnWithInterception({
      provider,
      messages: currentMessages,
      model: modelOverride,
      onChunk,
      onFinish: (r) => { finishReason = r; },
    });

    // Auto-continue if truncated (model hit output token limit)
    while (
      finishReason === "length" &&
      truncationCount < MAX_TRUNCATION_CONTINUATIONS
    ) {
      truncationCount++;
      logger.logInfo(`[truncation] Response cut off (attempt ${truncationCount}/${MAX_TRUNCATION_CONTINUATIONS}), continuing...`);
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: stripThinkingBlock(rawResponse) },
        { role: "user", content: TRUNCATION_CONTINUATION },
      ];
      finishReason = "stop";
      const continuation = await streamTurnWithInterception({
        provider,
        messages: currentMessages,
        model: modelOverride,
        onChunk,
        onFinish: (r) => { finishReason = r; },
      });
      rawResponse = rawResponse + continuation;
      // Remove the continuation messages we injected (keep history clean)
      currentMessages = currentMessages.slice(0, currentMessages.length - 2);
    }

    lastRawResponse = rawResponse;
    logger.logInfo("Raw LLM Response", { rawResponse });

    // ── Degenerate response detection ──────────────────────────────────
    if (isDegenerate(rawResponse)) {
      logger.logInfo("[loop-guard] Degenerate response detected in agent loop");
      return finalizeOutcome(
        logger,
        {
          response:
            "⚠️ REI detected a degenerate response (the model entered a text generation loop). " +
            "This usually happens when the context is saturated or the model is confused. " +
            "Try: /session new, reducing the context, increasing OLLAMA_NUM_CTX, or using a different model.",
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
        currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });
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
    const createFeedback = await handleCreateFileBlocks({
      rawResponse,
      workspacePath,
      logger,
    });

    if (createFeedback) {
      currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });
      currentMessages.push({
        role: "user",
        content:
          createFeedback +
          "\nPlease fix these issues and reply with corrected <create> blocks or continue with the next step.",
      });
      continue;
    }

    // 2. Did the model request more files?
    const fileRequests = extractFileRequests(rawResponse);
    if (fileRequests.length > 0) {
      logger.logInfo(`Agent requested files: ${fileRequests.join(", ")}`);
      const contextMessage = await buildFileContextMessage(
        workspacePath,
        fileRequests,
      );

      const rfId = generateXmlToolCallId("request_files");
      currentMessages.push({
        role: "assistant",
        content: stripThinkingBlock(rawResponse),
        tool_calls: [{ id: rfId, type: "function", function: { name: "request_files", arguments: JSON.stringify({ files: fileRequests }) } }],
      });
      currentMessages.push({ role: "tool", tool_call_id: rfId, name: "request_files", content: contextMessage });
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

        currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });
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
        consecutiveSearchMismatchFailures = mismatchOnly
          ? consecutiveSearchMismatchFailures + 1
          : 0;

        if (loopCount < MAX_TURNS) {
          logger.logInfo(
            `Virtual validation failed. Feeding back errors (Turn ${loopCount}/${MAX_TURNS}).`,
          );
          currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });

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
                `${valResult.feedback}\n\n` +
                `The previous <search> blocks did not match exact file content. ` +
                `Here are the full files to patch accurately:\n${contextMessage}\n` +
                `Please reply with corrected <edit> tags.`,
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

      return finalizeOutcome(
        logger,
        {
          response: getFinalResponse(rawResponse),
          validProposedPatches: edits,
        },
        edits.length,
        edits.length,
      );
    }

    // 3b. Did the model request commands?
    const commands = extractCommandRequests(rawResponse);
    if (commands.length > 0) {
      // Command loop detection: break if the same commands repeat across iterations
      const cmdSignature = buildCommandSignature(commands, [], []);
      if (cmdSignature && cmdSignature === lastCmdSignature) {
        logger.logInfo("[loop-guard] Repeated command signature detected, breaking agent loop", { cmdSignature });
        return finalizeOutcome(
          logger,
          {
            response:
              getFinalResponse(rawResponse) +
              "\n\n⚠️ REI detected a command loop — the model is repeating the same commands. " +
              "Stopping execution. Try asking it to explain the error instead of executing commands.",
                validProposedPatches: [],
          },
          0,
          0,
        );
      }
      lastCmdSignature = cmdSignature;

      let commandFeedback = "";
      for (const cmd of commands) {
        logger.logInfo(`Executing command: ${cmd}`);
        const cmdResult = await executeCommand(cmd, workspacePath);
        logger.logCommandExecution(cmd, cmdResult);
        const truncatedStdout = limitCommandOutput(cmdResult.stdout || "none");
        const truncatedStderr = limitCommandOutput(cmdResult.stderr || "none");
        commandFeedback +=
          `\nCommand: ${cmd}\nExit Code: ${cmdResult.exitCode}` +
          `\nStdout: ${truncatedStdout}\nStderr: ${truncatedStderr}\n`;
      }

      if (loopCount < MAX_TURNS) {
        const cmdId = generateXmlToolCallId("execute_command");
        currentMessages.push({
          role: "assistant",
          content: stripThinkingBlock(rawResponse),
          tool_calls: [{ id: cmdId, type: "function", function: { name: "execute_command", arguments: JSON.stringify({ commands }) } }],
        });
        currentMessages.push({ role: "tool", tool_call_id: cmdId, name: "execute_command", content: commandFeedback });
        continue;
      }

      return finalizeOutcome(
        logger,
        {
          response: getFinalResponse(rawResponse + "\n\n--- Command Execution Results ---\n" + commandFeedback),
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
      const toolFeedback = await executeToolCallsFromResponse(rawResponse, provider, logger, mcpRegistry);

      if (hasFeedbackCall && loopCount < MAX_TURNS) {
        const tcId = generateXmlToolCallId("call_tool");
        const toolNames = toolCalls.map((c) => c.name).join(",");
        currentMessages.push({
          role: "assistant",
          content: stripThinkingBlock(rawResponse),
          tool_calls: [{ id: tcId, type: "function", function: { name: toolNames, arguments: JSON.stringify(toolCalls.map((c) => c.args)) } }],
        });
        currentMessages.push({ role: "tool", tool_call_id: tcId, name: toolNames, content: toolFeedback });
        continue;
      }
      // Fire-and-forget only, or at max turns: append result to response and return.
      return finalizeOutcome(
        logger,
        {
          response: getFinalResponse(stripAllActionTags(rawResponse) + toolFeedback),
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
  }

  // Loop exhausted without any edits (e.g. only file requests, model never produced patches)
  return finalizeOutcome(
    logger,
    {
      response: buildMaxTurnsFailureMessage({
        loopCount,
        firstTurnExplanation,
        lastValidationError: lastValidationError || "No edits were produced within the turn limit.",
        failedEdits: lastEdits,
      }),
      validProposedPatches: [],
      failed: true,
      failedProposedPatches: lastEdits,
      lastValidationError: lastValidationError || "No edits were produced within the turn limit.",
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
  onChunk?: (event: { type: "thinking" | "text" | "status"; content: string }) => void;
  /** Connected MCP registry — required for MCP <call_tool> dispatch. */
  mcpRegistry?: McpRegistry;
  /** Set of tool names (from ToolDefinition.modelFeedback === true) whose results
   *  must be fed back to the model. Everything else is fire-and-forget. */
  modelFeedbackTools?: Set<string>;
}): Promise<ExecutionResult> {
  const { provider, messagesForModel, workspacePath, logger, modelOverride, onChunk, mcpRegistry, modelFeedbackTools } =
    params;
  let currentMessages = [...messagesForModel];
  let loopCount = 0;
  let truncationCount = 0;
  let lastRawResponse = "";
  let firstTurnExplanation = "";

  const getFinalResponse = (resp: string) => {
    if (loopCount > 1 && firstTurnExplanation && !resp.includes(firstTurnExplanation)) {
      return firstTurnExplanation + "\n\n" + resp;
    }
    return resp;
  };

  while (loopCount < MAX_TURNS) {
    loopCount++;

    let finishReason = "stop";
    let rawResponse = await streamTurnWithInterception({
      provider,
      messages: currentMessages,
      model: modelOverride,
      onChunk,
      onFinish: (r) => { finishReason = r; },
    });

    while (
      finishReason === "length" &&
      truncationCount < MAX_TRUNCATION_CONTINUATIONS
    ) {
      truncationCount++;
      logger.logInfo(`[truncation] Response cut off (attempt ${truncationCount}/${MAX_TRUNCATION_CONTINUATIONS}), continuing...`);
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: stripThinkingBlock(rawResponse) },
        { role: "user", content: TRUNCATION_CONTINUATION },
      ];
      finishReason = "stop";
      const continuation = await streamTurnWithInterception({
        provider,
        messages: currentMessages,
        model: modelOverride,
        onChunk,
        onFinish: (r) => { finishReason = r; },
      });
      rawResponse = rawResponse + continuation;
      currentMessages = currentMessages.slice(0, currentMessages.length - 2);
    }

    lastRawResponse = rawResponse;
    logger.logInfo("Raw LLM Response (wholefile mode)", { rawResponse });

    if (rawResponse.trim()) {
      if (loopCount === 1) {
        firstTurnExplanation = stripAllActionTags(rawResponse);
      }
    } else {
      if (loopCount < MAX_TURNS) {
        currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });
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

    // 1. <request_files> — inject file contents and continue
    const fileRequests = extractFileRequests(rawResponse);
    if (fileRequests.length > 0) {
      logger.logInfo(`Agent requested files: ${fileRequests.join(", ")}`);
      const contextMessage = await buildFileContextMessage(
        workspacePath,
        fileRequests,
      );
      const rfId2 = generateXmlToolCallId("request_files");
      currentMessages.push({
        role: "assistant",
        content: stripThinkingBlock(rawResponse),
        tool_calls: [{ id: rfId2, type: "function", function: { name: "request_files", arguments: JSON.stringify({ files: fileRequests }) } }],
      });
      currentMessages.push({ role: "tool", tool_call_id: rfId2, name: "request_files", content: contextMessage });
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

      const result = await applyWholeFileBatchFS(wholefileEdits, workspacePath);
      const failed = result.results.filter((r) => !r.applied);

      if (failed.length > 0) {
        const feedback =
          "Some <wholefile> blocks failed to write:\n" +
          failed
            .map((r) => `- ${r.file}: ${r.validationErrors.join("; ")}`)
            .join("\n");
        if (loopCount < MAX_TURNS) {
          currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });
          currentMessages.push({
            role: "user",
            content: feedback + "\nPlease retry.",
          });
          continue;
        }
        return finalizeOutcome(
          logger,
          { response: getFinalResponse(rawResponse), validProposedPatches: [], failed: true },
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
          const truncatedStdout = limitCommandOutput(cmdResult.stdout || "none");
          const truncatedStderr = limitCommandOutput(cmdResult.stderr || "none");
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
            currentMessages.push({ role: "assistant", content: stripThinkingBlock(rawResponse) });
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
        { response: getFinalResponse(rawResponse + summary), validProposedPatches: [] },
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
        const truncatedStdout = limitCommandOutput(cmdResult.stdout || "none");
        const truncatedStderr = limitCommandOutput(cmdResult.stderr || "none");
        commandFeedback +=
          `\nCommand: ${cmd}\nExit Code: ${cmdResult.exitCode}` +
          `\nStdout: ${truncatedStdout}\nStderr: ${truncatedStderr}\n`;
      }

      if (loopCount < MAX_TURNS) {
        const cmdId2 = generateXmlToolCallId("execute_command");
        currentMessages.push({
          role: "assistant",
          content: stripThinkingBlock(rawResponse),
          tool_calls: [{ id: cmdId2, type: "function", function: { name: "execute_command", arguments: JSON.stringify({ commands }) } }],
        });
        currentMessages.push({ role: "tool", tool_call_id: cmdId2, name: "execute_command", content: commandFeedback });
        continue;
      }

      return finalizeOutcome(
        logger,
        {
          response:
            getFinalResponse(
              rawResponse +
              "\n\n--- Command Execution Results ---\n" +
              commandFeedback
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
      const toolFeedback = await executeToolCallsFromResponse(rawResponse, provider, logger, mcpRegistry);

      if (hasFeedbackCall && loopCount < MAX_TURNS) {
        const tcId2 = generateXmlToolCallId("call_tool");
        const toolNames2 = toolCalls.map((c) => c.name).join(",");
        currentMessages.push({
          role: "assistant",
          content: stripThinkingBlock(rawResponse),
          tool_calls: [{ id: tcId2, type: "function", function: { name: toolNames2, arguments: JSON.stringify(toolCalls.map((c) => c.args)) } }],
        });
        currentMessages.push({ role: "tool", tool_call_id: tcId2, name: toolNames2, content: toolFeedback });
        continue;
      }
      return finalizeOutcome(
        logger,
        {
          response: getFinalResponse(stripAllActionTags(rawResponse) + toolFeedback),
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
    return finalizeOutcome(
      logger,
      { response: getFinalResponse(rawResponse), validProposedPatches: [] },
      0,
      0,
    );
  }

  return finalizeOutcome(
    logger,
    {
      response: buildMaxTurnsFailureMessage({
        loopCount,
        firstTurnExplanation,
        lastValidationError: "The agent loop exhausted all turns without writing files.",
        failedEdits: [],
      }),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}

