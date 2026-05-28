import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeCommand, limitCommandOutput } from "../../tools/command-executor.js";
import {
  extractCommandRequests,
  extractToolCalls,
  extractFileRequests,
} from "../../agent-mode/response-handler.js";
import {
  getWeather,
  formatWeatherOutput,
} from "../../tools/weather-tool.js";
import { searchWeb } from "../../tools/search-tool.js";
import type { AgentLogger } from "../logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { BatchPatchApplyResult } from "../../tools/patch-applier.js";

/**
 * Reads the contents of any <request_files> tags found in a response and returns formatted feedback.
 */
export async function executeFileRequestsFromResponse(
  response: string,
  workspacePath: string,
  logger: AgentLogger,
): Promise<string> {
  const fileRequests = extractFileRequests(response);
  if (fileRequests.length === 0) return "";

  let feedback = "\n\n---\n**Requested Files Context:**\n";
  for (const f of fileRequests) {
    logger.logInfo(`Non-agent requested file: ${f}`);
    const absPath = path.join(workspacePath, f);
    try {
      const content = await fs.readFile(absPath, "utf-8");
      feedback += `\n### File: ${f}\n\`\`\`\n${content}\n\`\`\`\n`;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      feedback += `\n### File: ${f}\n(Could not read file: ${errorMsg})\n`;
    }
  }
  return feedback;
}

/**
 * Executes any <execute_command> tags found in a response and returns formatted feedback.
 */
export async function executeCommandsFromResponse(
  response: string,
  workspacePath: string,
  logger: AgentLogger,
): Promise<string> {
  const commands = extractCommandRequests(response);
  if (commands.length === 0) return "";

  let feedback = "\n\n---\n**Command Results:**\n```\n";
  for (const cmd of commands) {
    logger.logInfo(`Executing command: ${cmd}`);
    const result = await executeCommand(cmd, workspacePath);
    logger.logCommandExecution(cmd, result);
    const output = limitCommandOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    );
    feedback += `$ ${cmd}\n${output || "(no output)"} [exit: ${result.exitCode}]\n\n`;
  }
  feedback += "```";
  return feedback;
}

/**
 * Executes any <call_tool> tags found in a response and returns formatted feedback.
 */
export async function executeToolCallsFromResponse(
  response: string,
  provider: ModelProvider,
  logger: AgentLogger,
): Promise<string> {
  const toolCalls = extractToolCalls(response);
  if (toolCalls.length === 0) return "";

  let feedback = "\n\n---\n**Tool Call Results:**\n";
  for (const call of toolCalls) {
    logger.logInfo(`Calling tool: ${call.name}`, { args: call.args });
    try {
      if (call.name === "weather") {
        const weatherRes = await getWeather(call.args.location as string);
        feedback += `\n### 🌤️ Weather: ${call.args.location}\n${formatWeatherOutput(weatherRes)}\n`;
      } else if (call.name === "search") {
        const searchRes = await searchWeb(
          call.args.query as string,
          provider,
        );
        feedback += `\n### 🔍 Search Results: ${call.args.query}\n${searchRes}\n`;
      } else {
        throw new Error(`Tool "${call.name}" is not implemented.`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      feedback += `\n[TOOL] ${call.name}(${JSON.stringify(call.args)}) -> ERROR: ${errorMsg}\n`;
    }
  }
  return feedback;
}

/**
 * Unifies execution of tools and commands specifically for Agent mode turns.
 */
export async function executeAgentToolsAndCommands(
  response: string,
  workspacePath: string,
  provider: ModelProvider,
  logger: AgentLogger,
): Promise<string> {
  const toolCalls = extractToolCalls(response);
  const commands = extractCommandRequests(response);

  if (toolCalls.length === 0 && commands.length === 0) {
    return "";
  }

  let feedback = "\n\n--- Execution Results ---\n";

  for (const call of toolCalls) {
    logger.logInfo(`Calling tool: ${call.name}`, { args: call.args });
    try {
      if (call.name === "weather") {
        const weatherRes = await getWeather(call.args.location as string);
        feedback += `\n### 🌤️ Weather: ${call.args.location}\n${formatWeatherOutput(weatherRes)}\n`;
      } else if (call.name === "search") {
        const searchRes = await searchWeb(
          call.args.query as string,
          provider,
        );
        feedback += `\n### 🔍 Search Results: ${call.args.query}\n${searchRes}\n`;
      } else {
        throw new Error(`Tool "${call.name}" is not implemented.`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      feedback += `\n[TOOL] ${call.name}(${JSON.stringify(call.args)}) -> ERROR: ${errorMsg}\n`;
    }
  }

  for (const cmd of commands) {
    logger.logInfo(`Executing command: ${cmd}`);
    const result = await executeCommand(cmd, workspacePath);
    logger.logCommandExecution(cmd, result);
    feedback += `\n[COMMAND] ${cmd} (Exit: ${result.exitCode})\nStdout: ${result.stdout || "none"}\nStderr: ${result.stderr || "none"}\n`;
  }

  return feedback;
}

/**
 * Formats the feedback report from applying a batch of Search-and-Replace edits to the filesystem.
 */
export function formatBatchPatchResult(result: BatchPatchApplyResult): string {
  const header = result.success
    ? `\n\n---\n\u001b[32m\u001b[1m${result.results.length} patch(es) applied directly.\u001b[0m`
    : `\n\n---\n\u001b[31m\u001b[1mSome patches failed to apply.\u001b[0m`;

  const details = result.results
    .map(
      (r) =>
        `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
    )
    .join("");

  return header + details;
}

/**
 * Executes and formats the turn actions (<request_files>, <execute_command>, <call_tool>) for streaming responses.
 */
export async function executeAndFormatTurnActions(params: {
  response: string;
  workspacePath: string;
  provider: ModelProvider;
  logger: AgentLogger;
}): Promise<{ executionFeedback: string; userVisibleFeedback: string }> {
  const { response, workspacePath, provider, logger } = params;
  const fileRequests = extractFileRequests(response);
  const commands = extractCommandRequests(response);
  const toolCalls = extractToolCalls(response);

  let executionFeedback = "";
  let userVisibleFeedback = "";

  if (fileRequests.length > 0) {
    const fileFeedback = await executeFileRequestsFromResponse(
      response,
      workspacePath,
      logger,
    );
    executionFeedback += fileFeedback;
    userVisibleFeedback +=
      `\n📂 **[REI] Injected ${fileRequests.length} requested file(s) into context:**\n` +
      fileRequests.map((f) => `- \`${f}\``).join("\n") +
      "\n";
  }

  if (commands.length > 0) {
    const cmdFeedback = await executeCommandsFromResponse(
      response,
      workspacePath,
      logger,
    );
    executionFeedback += cmdFeedback;
    userVisibleFeedback += cmdFeedback;
  }

  if (toolCalls.length > 0) {
    const toolFeedback = await executeToolCallsFromResponse(
      response,
      provider,
      logger,
    );
    executionFeedback += toolFeedback;
    userVisibleFeedback += toolFeedback;
  }

  return { executionFeedback, userVisibleFeedback };
}
