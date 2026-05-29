/**
 * Agent mode generator using structured function/tool calling.
 * Used when the active provider implements completeChatWithTools.
 * Falls back to the XML-based generator if not.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentLogger } from "../core/logger.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { AGENT_TOOLS } from "../contracts/tool-definitions.js";
import { executeCommand, limitCommandOutput } from "../tools/command-executor.js";
import {
  buildFileContextMessage,
  finalizeOutcome,
  validateProposedPatches,
  type ExecutionResult,
} from "./helpers/patch-helpers.js";

const MAX_TURNS = process.env.REI_MAX_TURNS ? parseInt(process.env.REI_MAX_TURNS, 10) : 7;
const MAX_TRUNCATION_CONTINUATIONS = 3;
const TRUNCATION_CONTINUATION =
  "Your previous response was cut off by the output token limit. " +
  "Continue EXACTLY from where you left off — do NOT repeat, summarize, or restart. " +
  "Just continue the text as one uninterrupted response.";

/**
 * Executes an agent turn using native function/tool calling instead of XML parsing.
 * Returns the same ExecutionResult shape as the XML generator so callers are interchangeable.
 */
export async function executeAgentTurnWithTools(params: {
  provider: ModelProvider;
  messagesForModel: ChatMessage[];
  workspacePath: string;
  logger: AgentLogger;
  modelOverride?: string;
}): Promise<ExecutionResult> {
  const { provider, messagesForModel, workspacePath, logger, modelOverride } = params;

  if (!provider.completeChatWithTools) {
    throw new Error("executeAgentTurnWithTools: provider does not support completeChatWithTools");
  }

  let currentMessages: ChatMessage[] = [...messagesForModel];
  let loopCount = 0;
  let firstTurnExplanation = "";

  while (loopCount < MAX_TURNS) {
    loopCount++;

    logger.logInfo(`[tools] Turn ${loopCount}/${MAX_TURNS}`);

    const result = await provider.completeChatWithTools(
      currentMessages,
      AGENT_TOOLS,
      { model: modelOverride },
    );

    logger.logInfo("[tools] Response", {
      finishReason: result.finishReason,
      toolCalls: result.toolCalls.map((tc) => tc.function.name),
      contentPreview: result.content.slice(0, 120),
    });

    // Auto-continue if truncated (no tool calls and output was cut off)
    if (result.finishReason === "length" && result.toolCalls.length === 0) {
      let accumulated = result.content;
      let truncationCount = 0;
      let lastReason = result.finishReason;

      while (lastReason === "length" && truncationCount < MAX_TRUNCATION_CONTINUATIONS) {
        truncationCount++;
        logger.logInfo(`[truncation] tools response cut off (${truncationCount}/${MAX_TRUNCATION_CONTINUATIONS}), continuing...`);
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: accumulated },
          { role: "user", content: TRUNCATION_CONTINUATION },
        ];
        const cont = await provider.completeChatWithTools!(
          currentMessages,
          AGENT_TOOLS,
          { model: modelOverride },
        );
        accumulated = accumulated + cont.content;
        lastReason = cont.finishReason;
        currentMessages = currentMessages.slice(0, currentMessages.length - 2);
      }

      return finalizeOutcome(logger, {
        response: firstTurnExplanation || accumulated,
        validProposedPatches: [],
      }, 0, 0);
    }

    // Capture text explanation from first turn
    if (loopCount === 1 && result.content.trim()) {
      firstTurnExplanation = result.content.trim();
    }

    // ── No tool calls: plain text response ────────────────────────────────
    if (result.toolCalls.length === 0) {
      const response = firstTurnExplanation && result.content !== firstTurnExplanation
        ? firstTurnExplanation + "\n\n" + result.content
        : result.content;
      return finalizeOutcome(logger, { response, validProposedPatches: [] }, 0, 0);
    }

    // ── Process tool calls ─────────────────────────────────────────────────
    // Add the assistant message with tool_calls to history
    currentMessages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls,
    });

    const pendingEdits: AgentSREdit[] = [];
    let hasToolFailure = false;

    for (const call of result.toolCalls) {
      let toolResult: string;

      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

        switch (call.function.name) {
          // ── read_files ───────────────────────────────────────────────
          case "read_files": {
            const paths = (args.paths as string[]) ?? [];
            logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
            toolResult = await buildFileContextMessage(workspacePath, paths);
            break;
          }

          // ── edit_file ────────────────────────────────────────────────
          case "edit_file": {
            const edit: AgentSREdit = {
              file: args.file as string,
              search: args.search as string,
              replace: args.replace as string,
            };
            logger.logInfo(`[tools] edit_file: ${edit.file}`);
            // Validate immediately so the model gets per-edit feedback
            const validation = await validateProposedPatches({
              workspacePath,
              edits: [edit],
              loopCount,
              logger,
            });
            if (validation.success) {
              pendingEdits.push(edit);
              toolResult = `OK: edit queued for ${edit.file}`;
            } else {
              hasToolFailure = true;
              toolResult = `ERROR: ${validation.feedback ?? "search block did not match file content"}`;
            }
            break;
          }

          // ── create_file ──────────────────────────────────────────────
          case "create_file": {
            const filePath = path.join(workspacePath, args.file as string);
            const exists = await fs.stat(filePath).then(() => true).catch(() => false);
            if (exists) {
              toolResult = `SKIPPED: ${args.file} already exists — use edit_file to modify it`;
            } else {
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, args.content as string, "utf-8");
              logger.logInfo(`[tools] create_file: ${args.file}`);
              toolResult = `OK: ${args.file} created`;
            }
            break;
          }

          // ── run_command ──────────────────────────────────────────────
          case "run_command": {
            const cmd = args.command as string;
            logger.logInfo(`[tools] run_command: ${cmd}`);
            const cmdResult = await executeCommand(cmd, workspacePath);
            logger.logCommandExecution(cmd, cmdResult);
            const stdout = limitCommandOutput(cmdResult.stdout ?? "");
            const stderr = limitCommandOutput(cmdResult.stderr ?? "");
            toolResult = `Exit: ${cmdResult.exitCode}\n` +
              (stdout ? `Stdout:\n${stdout}\n` : "") +
              (stderr ? `Stderr:\n${stderr}\n` : "") || "(no output)";
            break;
          }

          default:
            toolResult = `ERROR: Unknown tool "${call.function.name}"`;
            hasToolFailure = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResult = `ERROR: ${msg}`;
        hasToolFailure = true;
      }

      currentMessages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: call.id,
        name: call.function.name,
      });
    }

    // ── If we collected valid edits and nothing failed, return them ────────
    if (pendingEdits.length > 0 && !hasToolFailure) {
      return finalizeOutcome(
        logger,
        {
          response: firstTurnExplanation,
          validProposedPatches: pendingEdits,
        },
        pendingEdits.length,
        pendingEdits.length,
      );
    }

    // ── If only file reads or commands happened, loop so model can continue
    // ── If there were failures, loop so model can retry with error feedback
  }

  return finalizeOutcome(
    logger,
    {
      response: [
        `⚠️ REI could not complete the task after ${loopCount} attempts.`,
        "",
        ...(firstTurnExplanation ? ["**What was planned:**", firstTurnExplanation, ""] : []),
        "**What to try next:**",
        "- Ask REI to re-read the files first: *\"Read [file] and retry\"*",
        `- Increase the turn limit: set \`REI_MAX_TURNS=${MAX_TURNS + 3}\` in your .env`,
      ].join("\n"),
      validProposedPatches: [],
      failed: true,
    },
    0,
    0,
  );
}
