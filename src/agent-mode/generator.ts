import type { ChatSession } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import {
  extractFileRequests,
  extractSREdits,
  extractWholeFileEdits,
  extractCommandRequests,
  formatSREditsForLog,
} from "./response-handler.js";
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
  type ExecutionResult,
} from "./helpers/patch-helpers.js";
import { streamTurnWithInterception } from "./helpers/token-streamer.js";

const MAX_TURNS = process.env.REI_MAX_TURNS ? parseInt(process.env.REI_MAX_TURNS, 10) : 7;

export async function executeAgentTurn(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
  modelOverride?: string;
  onChunk?: (event: { type: "thinking" | "status"; content: string }) => void;
}): Promise<ExecutionResult> {
  const {
    provider,
    messagesForModel,
    workspacePath,
    scannedFiles,
    logger,
    modelOverride,
    onChunk,
  } = params;

  let currentMessages = [...messagesForModel];
  let loopCount = 0;

  // Track last known state for failure recovery
  let lastRawResponse = "";
  let lastEdits: AgentSREdit[] = [];
  let lastValidationError = "";
  let consecutiveSearchMismatchFailures = 0;
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

    // 1. Ask the LLM
    const rawResponse = await streamTurnWithInterception({
      provider,
      messages: currentMessages,
      model: modelOverride,
      onChunk,
    });
    lastRawResponse = rawResponse;
    logger.logInfo("Raw LLM Response", { rawResponse });

    if (rawResponse.trim()) {
      if (loopCount === 1) {
        firstTurnExplanation = stripAllActionTags(rawResponse);
      }
    } else {
      logger.logInfo("Model returned empty response", { loopCount });
      if (loopCount < MAX_TURNS) {
        currentMessages.push({ role: "assistant", content: rawResponse });
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
      currentMessages.push({ role: "assistant", content: rawResponse });
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
            response: getFinalResponse(lastRawResponse),
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
        currentMessages.push({ role: "assistant", content: rawResponse });
        currentMessages.push({
          role: "user",
          content: `Command execution results:\n${commandFeedback}\nPlease continue with the task.`,
        });
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

  // Loop exhausted without any edits (e.g. only file requests)
  return finalizeOutcome(
    logger,
    {
      response: getFinalResponse(
        lastRawResponse ||
        "Agent loop exceeded maximum turns without producing edits."
      ),
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
  onChunk?: (event: { type: "thinking" | "status"; content: string }) => void;
}): Promise<ExecutionResult> {
  const { provider, messagesForModel, workspacePath, logger, modelOverride, onChunk } =
    params;
  let currentMessages = [...messagesForModel];
  let loopCount = 0;
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

    const rawResponse = await streamTurnWithInterception({
      provider,
      messages: currentMessages,
      model: modelOverride,
      onChunk,
    });
    lastRawResponse = rawResponse;
    logger.logInfo("Raw LLM Response (wholefile mode)", { rawResponse });

    if (rawResponse.trim()) {
      if (loopCount === 1) {
        firstTurnExplanation = stripAllActionTags(rawResponse);
      }
    } else {
      if (loopCount < MAX_TURNS) {
        currentMessages.push({ role: "assistant", content: rawResponse });
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
      currentMessages.push({ role: "assistant", content: rawResponse });
      currentMessages.push({
        role: "user",
        content: `Here are the requested files:\n${contextMessage}\nPlease continue your task.`,
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

      const result = await applyWholeFileBatchFS(wholefileEdits, workspacePath);
      const failed = result.results.filter((r) => !r.applied);

      if (failed.length > 0) {
        const feedback =
          "Some <wholefile> blocks failed to write:\n" +
          failed
            .map((r) => `- ${r.file}: ${r.validationErrors.join("; ")}`)
            .join("\n");
        if (loopCount < MAX_TURNS) {
          currentMessages.push({ role: "assistant", content: rawResponse });
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
            currentMessages.push({ role: "assistant", content: rawResponse });
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
        currentMessages.push({ role: "assistant", content: rawResponse });
        currentMessages.push({
          role: "user",
          content: `Command execution results:\n${commandFeedback}\nPlease continue with the task.`,
        });
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
      response: getFinalResponse(lastRawResponse || "Agent loop exceeded maximum turns."),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}

