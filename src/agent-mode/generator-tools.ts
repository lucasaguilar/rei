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
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import { AGENT_TOOLS, mcpToolsToDefinitions } from "../contracts/tool-definitions.js";
import { executeCommand, limitCommandOutput } from "../tools/command-executor.js";
import {
  buildFileContextMessage,
  finalizeOutcome,
  validateProposedPatches,
  CREATED_FILES_MARKER,
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
  /** Connected MCP registry. When provided, MCP tools are merged into the tool list. */
  mcpRegistry?: McpRegistry;
  /** Live progress callback — emits "status" chunks as each tool runs so the
   *  user sees activity (this path is otherwise silent until the turn ends). */
  onChunk?: (event: { type: "thinking" | "text" | "status"; content: string }) => void;
}): Promise<ExecutionResult> {
  const { provider, messagesForModel, workspacePath, logger, modelOverride, mcpRegistry, onChunk } = params;

  if (!provider.completeChatWithTools) {
    throw new Error("executeAgentTurnWithTools: provider does not support completeChatWithTools");
  }

  // Emits a one-line live status for a tool action (shown immediately by the CLI).
  const emitStatus = (msg: string) => onChunk?.({ type: "status", content: `\n\x1b[33m${msg}\x1b[0m\n` });

  const mcpDefinitions = mcpRegistry ? mcpToolsToDefinitions(mcpRegistry.getAvailableTools()) : [];
  const allTools = [...AGENT_TOOLS, ...mcpDefinitions];

  let currentMessages: ChatMessage[] = [...messagesForModel];
  let loopCount = 0;
  let firstTurnExplanation = "";
  // Files created via create_file across the loop — surfaced to the user, since
  // the native tool path otherwise only reports creation back to the model.
  const createdFiles: string[] = [];

  const appendCreatedSummary = (resp: string): string => {
    if (createdFiles.length === 0) return resp;
    const unique = [...new Set(createdFiles)];
    return (
      resp +
      `${CREATED_FILES_MARKER}${unique.length} file(s) created:[0m\n` +
      unique.map((f) => `- ${f}`).join("\n")
    );
  };

  while (loopCount < MAX_TURNS) {
    loopCount++;

    logger.logInfo(`[tools] Turn ${loopCount}/${MAX_TURNS}`);

    const result = await provider.completeChatWithTools(
      currentMessages,
      allTools,
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
        response: appendCreatedSummary(firstTurnExplanation || accumulated),
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
      return finalizeOutcome(logger, { response: appendCreatedSummary(response), validProposedPatches: [] }, 0, 0);
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

    // Track edit tasks and all tool results by call ID to preserve correct response order
    interface EditTask {
      callId: string;
      edit: AgentSREdit;
    }
    const editTasks: EditTask[] = [];
    const toolResultsMap = new Map<string, string>();

    for (const call of result.toolCalls) {
      let toolResult: string;

      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

        switch (call.function.name) {
          // ── read_files ───────────────────────────────────────────────
          case "read_files": {
            const paths = (args.paths as string[]) ?? [];
            logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
            emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);
            toolResult = await buildFileContextMessage(workspacePath, paths);
            toolResultsMap.set(call.id, toolResult);
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
            emitStatus(`🛠️  [REI] Editing: ${edit.file}`);
            editTasks.push({ callId: call.id, edit });
            break;
          }

          // ── create_file ──────────────────────────────────────────────
          case "create_file": {
            const filePath = path.join(workspacePath, args.file as string);
            const exists = await fs.stat(filePath).then(() => true).catch(() => false);
            emitStatus(`📂  [REI] Creating: ${args.file}`);
            if (exists) {
              toolResult = `SKIPPED: ${args.file} already exists — use edit_file to modify it`;
            } else {
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, args.content as string, "utf-8");
              logger.logInfo(`[tools] create_file: ${args.file}`);
              createdFiles.push(args.file as string);
              toolResult = `OK: ${args.file} created`;
            }
            toolResultsMap.set(call.id, toolResult);
            break;
          }

          // ── run_command ──────────────────────────────────────────────
          case "run_command": {
            const cmd = args.command as string;
            logger.logInfo(`[tools] run_command: ${cmd}`);
            emitStatus(`💻  [REI] Running: ${cmd}`);
            const cmdResult = await executeCommand(cmd, workspacePath);
            logger.logCommandExecution(cmd, cmdResult);
            const stdout = limitCommandOutput(cmdResult.stdout ?? "");
            const stderr = limitCommandOutput(cmdResult.stderr ?? "");
            toolResult = `Exit: ${cmdResult.exitCode}\n` +
              (stdout ? `Stdout:\n${stdout}\n` : "") +
              (stderr ? `Stderr:\n${stderr}\n` : "") || "(no output)";
            toolResultsMap.set(call.id, toolResult);
            break;
          }

          default: {
            if (call.function.name.startsWith("mcp:") && mcpRegistry) {
              // Strip the "mcp:" namespace prefix added by mcpToolsToDefinitions before
              // dispatching — the registry key is "serverName/toolName" not "mcp:...".
              const qualifiedName = call.function.name.slice(4);
              logger.logInfo(`[tools] mcp: ${qualifiedName}`);
              emitStatus(`🔧  [REI] Tool: ${qualifiedName}`);
              toolResult = await mcpRegistry.dispatch(qualifiedName, args);
            } else {
              toolResult = `ERROR: Unknown tool "${call.function.name}"`;
              hasToolFailure = true;
            }
            toolResultsMap.set(call.id, toolResult);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResultsMap.set(call.id, `ERROR: ${msg}`);
        hasToolFailure = true;
      }
    }

    // Perform a single batch validation for all proposed edits in this turn
    if (editTasks.length > 0) {
      const batchEdits = editTasks.map((t) => t.edit);
      const validation = await validateProposedPatches({
        workspacePath,
        edits: batchEdits,
        loopCount,
        logger,
      });

      if (validation.success) {
        pendingEdits.push(...batchEdits);
        for (const task of editTasks) {
          toolResultsMap.set(task.callId, `OK: edit queued for ${task.edit.file}`);
        }
      } else {
        hasToolFailure = true;
        for (const task of editTasks) {
          toolResultsMap.set(
            task.callId,
            `ERROR: ${validation.feedback ?? "compilation or search block mismatch in batch"}`
          );
        }
      }
    }

    // Feed back all tool results to model history in correct chronological order
    for (const call of result.toolCalls) {
      const res = toolResultsMap.get(call.id) ?? "ERROR: Tool execution failed";
      currentMessages.push({
        role: "tool",
        content: res,
        tool_call_id: call.id,
        name: call.function.name,
      });
    }

    // ── If we collected valid edits and nothing failed, return them ────────
    if (pendingEdits.length > 0 && !hasToolFailure) {
      return finalizeOutcome(
        logger,
        {
          response: appendCreatedSummary(firstTurnExplanation),
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
