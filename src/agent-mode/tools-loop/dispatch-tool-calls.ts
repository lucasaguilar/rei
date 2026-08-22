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
  handleAskUser,
  handleRunCommand,
  handleGitChanges,
  handleSaveToolOutput,
} from "./builtin-handlers.js";
import { retainAndMaybeSpill } from "./tool-output-store.js";
import { grepCode, listFiles } from "../../tools/code-search.js";
import { nonInteractiveElicit, type ElicitFn } from "../../chat/elicitation.js";
import { handleDelegate } from "./delegate-handler.js";
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
 *  (activeMcp grows via search_tools; virtualFiles/createdFiles via the handlers). */
export interface DispatchContext {
  workspacePath: string;
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
  /** Asks the user a question mid-turn (ask_user tool). Frontend-provided; defaults to the
   *  non-interactive safe default when absent (headless/server). See docs/intent-router-spec.md. */
  elicit?: ElicitFn;
  provider: ModelProvider;
  mcpRegistry?: McpRegistry;
  // read_files (virtual-file state)
  toRel: (raw: string) => string;
  currentContent: (file: string) => Promise<string>;
  virtualFiles: Map<string, string>;
  // meta-tools
  allMcpTools: McpTool[];
  activeMcp: Set<string>;
  skills: Skill[];
  // edit handlers
  resolveTarget: (raw: unknown) => string;
  createdFiles: string[];
  /** command string → times already executed THIS run, for the run_command loop-guard.
   *  Mutated by reference; cleared by the loop after edits change disk state so a legit
   *  post-edit re-verification (e.g. `npx tsc --noEmit`) is allowed to run again. */
  commandHistory: Map<string, number>;
}

export interface DispatchResult {
  /** True if any tool call failed (bad args, unknown tool, thrown error). */
  hasToolFailure: boolean;
  /** Queued search→replace / whole-file edits, applied together after dispatch. */
  editTasks: EditTask[];
  /** call id → tool result, fed back to the model in chronological order. */
  toolResultsMap: Map<string, string>;
  /** run_command calls intercepted as exact repeats this turn (loop-guard). The loop uses this to
   *  escalate/abandon when a turn does NOTHING but re-issue already-run commands. */
  blockedRepeatCount: number;
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
    elicit,
    provider,
    mcpRegistry,
    toRel,
    currentContent,
    virtualFiles,
    allMcpTools,
    activeMcp,
    skills,
    resolveTarget,
    createdFiles,
    commandHistory,
  } = ctx;

  let hasToolFailure = false;
  let blockedRepeatCount = 0;

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
          const rf = await handleReadFiles(
            (args.paths as string[]) ?? [],
            { workspacePath, logger, emitStatus, toRel, currentContent, virtualFiles },
            { offset: args.offset as number | undefined, limit: args.limit as number | undefined },
          );
          toolResult = rf.text;
          // No re-read guard: read_files always serves the file. If the model asks for it, it gets it.
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── grep_code (repo search) ──────────────────────────────────
        case "grep_code": {
          emitStatus(`🔎  [REI] grep_code: ${(args.pattern as string) ?? ""}`);
          toolResult = await grepCode(workspacePath, {
            pattern: (args.pattern as string) ?? "",
            path: args.path as string | undefined,
            glob: args.glob as string | undefined,
            maxResults: args.max_results as number | undefined,
          });
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── list_files (glob) ────────────────────────────────────────
        case "list_files": {
          emitStatus(`📁  [REI] list_files: ${(args.glob as string) ?? "*"}`);
          toolResult = await listFiles(workspacePath, {
            glob: args.glob as string | undefined,
            path: args.path as string | undefined,
            maxResults: args.max_results as number | undefined,
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

        // ── ask_user (built-in) ──────────────────────────────────────
        case "ask_user": {
          toolResult = await handleAskUser(
            (args.question as string) ?? "",
            args.options as string[] | undefined,
            { logger, emitStatus, elicit: elicit ?? nonInteractiveElicit },
          );
          toolResultsMap.set(call.id, toolResult);
          break;
        }

        // ── delegate (sub-agent, isolated context) ───────────────────
        case "delegate": {
          toolResult = await handleDelegate(args as { task?: unknown; files?: unknown }, {
            provider,
            workspacePath,
            logger,
            mcpRegistry,
            emitStatus,
            elicit,
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
          const cmd = ((args.command as string) ?? "").trim();
          const priorRuns = commandHistory.get(cmd) ?? 0;
          commandHistory.set(cmd, priorRuns + 1);
          // Loop-guard: re-running the EXACT same command returns the same output and makes no
          // progress — a classic local-model repetition loop (e.g. running the same `find`/`grep`
          // over and over instead of read_files). Intercept the repeat with a nudge instead of
          // executing it. State-changing turns clear this history (see the loop), so a legit
          // post-edit re-verification still runs.
          if (cmd && priorRuns >= 1) {
            blockedRepeatCount++;
            logger.logInfo(`[tools] run_command loop-guard: blocked repeat`, {
              command: cmd,
              priorRuns,
            });
            emitStatus(`↩️  [REI] Comando repetido bloqueado: ${cmd}`);
            toolResult =
              `You already ran this exact command earlier this turn:\n  ${cmd}\n` +
              `Its output is in the conversation above — re-running it returns the SAME result and ` +
              `makes no progress. Do NOT run it again.\n` +
              `• If you were locating a file, you already have its path: call read_files with that ` +
              `path to read the WHOLE file.\n` +
              `• If you already have enough information, STOP exploring and write your final ` +
              `answer/plan now.`;
            toolResultsMap.set(call.id, toolResult);
            break;
          }
          toolResult = await handleRunCommand(cmd, {
            logger,
            emitStatus,
            workspacePath,
            elicit,
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

        // ── save_tool_output (data-plane sink) ───────────────────────
        case "save_tool_output": {
          toolResult = handleSaveToolOutput(
            args as { path?: unknown; id?: unknown },
            { workspacePath },
          );
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
            // Retain the full result + spill large ones to disk, returning a short receipt to the
            // model (control plane) instead of the raw bytes (data plane). Prevents a backend like
            // MTPLX from truncating a big fetched document out of the model's view.
            toolResult = retainAndMaybeSpill(
              qualifiedName,
              await mcpRegistry.dispatch(qualifiedName, args),
              workspacePath,
            );
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

  return { hasToolFailure, editTasks, toolResultsMap, blockedRepeatCount };
}
