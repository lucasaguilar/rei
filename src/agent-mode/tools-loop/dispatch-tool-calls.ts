import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { ToolCall } from "../../providers/model-provider.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";
import type { Skill } from "../../skills/skill-loader.js";
import { startToolSpan } from "../../telemetry/spans.js";
import { handleReadFiles } from "./read-files-handler.js";
import {
  handleWebSearch,
  handleWeather,
  handleRunCommand,
  handleGitChanges,
} from "./builtin-handlers.js";
import {
  handleEditFile,
  handleRewriteFile,
  handleCreateFile,
  type EditTask,
  type EditHandlerContext,
} from "./edit-handlers.js";
import { handleSearchTools, handleUseSkill } from "./meta-handlers.js";

type McpTool = ReturnType<McpRegistry["getAvailableTools"]>[number];

/** Everything the per-call dispatch needs from the loop. Maps/sets are mutated BY REFERENCE
 *  (activeMcp grows via search_tools; virtualFiles/alreadyProvided/createdFiles via the handlers). */
export interface DispatchContext {
  workspacePath: string;
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
  provider: ModelProvider;
  mcpRegistry?: McpRegistry;
  // read_files (virtual-file state)
  toRel: (raw: string) => string;
  currentContent: (file: string) => Promise<string>;
  virtualFiles: Map<string, string>;
  alreadyProvided: Map<string, string>;
  // meta-tools
  allMcpTools: McpTool[];
  activeMcp: Set<string>;
  skills: Skill[];
  // edit handlers
  resolveTarget: (raw: unknown) => string;
  createdFiles: string[];
}

export interface DispatchResult {
  /** True if any tool call failed (bad args, unknown tool, thrown error). */
  hasToolFailure: boolean;
  /** Queued search→replace / whole-file edits, applied together after dispatch. */
  editTasks: EditTask[];
  /** call id → tool result, fed back to the model in chronological order. */
  toolResultsMap: Map<string, string>;
}

/**
 * Executes every tool call in one assistant turn: a `tool.<name>` span per call, JSON-arg parse,
 * and dispatch to the extracted handlers (read_files / search_tools / web_search / weather /
 * use_skill / edit_file / rewrite_file / create_file / run_command / mcp:*). Edits are only QUEUED
 * here (into editTasks); the caller applies them as a batch afterward. Extracted from
 * executeAgentTurnWithTools (Phase 2) so the loop reads as a sequence of named steps.
 */
export async function dispatchToolCalls(
  toolCalls: ToolCall[],
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const {
    workspacePath,
    logger,
    emitStatus,
    provider,
    mcpRegistry,
    toRel,
    currentContent,
    virtualFiles,
    alreadyProvided,
    allMcpTools,
    activeMcp,
    skills,
    resolveTarget,
    createdFiles,
  } = ctx;

  let hasToolFailure = false;

  // Track edit tasks and all tool results by call ID to preserve correct response order
  const editTasks: EditTask[] = [];
  const toolResultsMap = new Map<string, string>();

  // Shared context for the edit handlers (they push to editTasks/createdFiles by reference).
  const editCtx: EditHandlerContext = {
    workspacePath,
    logger,
    emitStatus,
    resolveTarget,
    editTasks,
    createdFiles,
  };

  for (const call of toolCalls) {
    let toolResult: string;

    // `tool.<name>` span for each call. run_command and mcp:* tools are already traced at
    // their executors (executeCommand / McpRegistry.dispatch), so skip them here to avoid
    // double-wrapping; the inline built-ins have no shared executor and are traced here.
    const endTool =
      call.function.name === "run_command" ||
      call.function.name.startsWith("mcp:")
        ? null
        : startToolSpan(call.function.name, {
            arguments: call.function.arguments,
          });
    try {
      const args = JSON.parse(call.function.arguments) as Record<
        string,
        unknown
      >;

      switch (call.function.name) {
        // ── read_files ───────────────────────────────────────────────
        case "read_files": {
          toolResult = await handleReadFiles((args.paths as string[]) ?? [], {
            workspacePath,
            logger,
            emitStatus,
            toRel,
            currentContent,
            virtualFiles,
            alreadyProvided,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── search_tools (meta-tool) ─────────────────────────────────
        case "search_tools": {
          toolResult = handleSearchTools((args.query as string) ?? "", {
            logger,
            emitStatus,
            allMcpTools,
            activeMcp,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── web_search (built-in) ────────────────────────────────────
        case "web_search": {
          toolResult = await handleWebSearch((args.query as string) ?? "", {
            logger,
            emitStatus,
            provider,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── weather (built-in) ───────────────────────────────────────
        case "weather": {
          toolResult = await handleWeather((args.location as string) ?? "", {
            logger,
            emitStatus,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── use_skill (meta-tool) ────────────────────────────────────
        case "use_skill": {
          toolResult = handleUseSkill((args.name as string) ?? "", {
            logger,
            emitStatus,
            skills,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── edit_file ────────────────────────────────────────────────
        case "edit_file": {
          const r = handleEditFile(args, call.id, editCtx);
          if (r.toolResult) toolResultsMap.set(call.id, r.toolResult);
          if (r.failed) hasToolFailure = true;
          break;
        }

        // ── rewrite_file ─────────────────────────────────────────────
        case "rewrite_file": {
          const r = await handleRewriteFile(args, call.id, editCtx);
          if (r.toolResult) toolResultsMap.set(call.id, r.toolResult);
          if (r.failed) hasToolFailure = true;
          break;
        }

        // ── create_file ──────────────────────────────────────────────
        case "create_file": {
          const r = await handleCreateFile(args, editCtx);
          if (r.toolResult) toolResultsMap.set(call.id, r.toolResult);
          if (r.failed) hasToolFailure = true;
          break;
        }

        // ── run_command ──────────────────────────────────────────────
        case "run_command": {
          toolResult = await handleRunCommand(args.command as string, {
            logger,
            emitStatus,
            workspacePath,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── git_changes (built-in) ───────────────────────────────────
        case "git_changes": {
          toolResult = await handleGitChanges({ logger, emitStatus, workspacePath });
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
    } finally {
      endTool?.();
    }
  }

  return { hasToolFailure, editTasks, toolResultsMap };
}
