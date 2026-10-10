import type { AgentLogger } from "../../core/logger.js";
import { runReadTool } from "./read-tool-handlers.js";
import { fromWireToolName } from "../../contracts/mcp-tool-names.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { ToolCall } from "../../providers/model-provider.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";
import type { Skill } from "../../skills/skill-loader.js";
import { startToolSpan } from "../../telemetry/spans.js";
import {
  handleWebSearch,
  handleWeather,
  handleAskUser,
  handleRunCommand,
  handleGitChanges,
  handleSaveToolOutput,
} from "./builtin-handlers.js";
import { isWriteAllowed, writeDeniedMessage, writeScopeForMode } from "./write-scope.js";
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
import { gateMcpCall } from "./mcp-call-gate.js";
import { checkMcpCall } from "./mcp-invalid-retry.js";

type McpTool = ReturnType<McpRegistry["getAvailableTools"]>[number];

/** Everything the per-call dispatch needs from the loop. Maps/sets are mutated BY REFERENCE
 *  (activeMcp grows via search_tools; virtualFiles/createdFiles via the handlers). */
export interface DispatchContext {
  workspacePath: string;
  /** Active session mode — decides which paths this turn may write to (see write-scope). */
  mode?: string;
  /** An active role's `writeGlob`, which narrows that scope further. */
  roleWriteGlob?: string;
  /** When set, a call to any other tool is refused, not run. See StreamTurnOptions.allowedTools. */
  allowedTools?: readonly string[];
  /** Read tools stay inside this directory and out of `.rei/`. See read-scope. */
  readRoot?: string;
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
  /** MCP schema rejections per tool+problem THIS run, to escalate the same mistake repeated.
   *  Not cleared by edits: a disk change does not fix a misnamed argument. Absent → no memory. */
  invalidMcpCalls?: Map<string, number>;
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
    mode,
    roleWriteGlob,
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
    invalidMcpCalls = new Map<string, number>(),
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

    // Not offering a tool is not enough: a model can emit a call to one it was never shown (from
    // its training, or from the prompt). Outside the allow-list it is refused here, before any
    // handler — this check is what actually keeps run_command off a channel like WhatsApp.
    // search_tools is the exception: it only searches allMcpTools, which setupToolSelection already
    // narrowed to the allow-list — it can load allowed tools, never others.
    if (
      ctx.allowedTools &&
      !ctx.allowedTools.includes(call.function.name) &&
      call.function.name !== "search_tools"
    ) {
      logger.logInfo(`[tools] refused ${call.function.name}: not in this turn's allowedTools`);
      toolResultsMap.set(
        call.id,
        `ERROR: the tool "${call.function.name}" is not available in this channel. ` +
          `Available: ${ctx.allowedTools.join(", ")}.`,
      );
      hasToolFailure = true;
      continue;
    }

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
      // read_files / grep_code / list_files, inside the turn's read scope — see read-tool-handlers.
      const readResult = await runReadTool(call.function.name, args, {
        workspacePath, logger, emitStatus, toRel, currentContent, virtualFiles, readRoot: ctx.readRoot,
      });
      if (readResult !== undefined) {
        toolResultsMap.set(call.id, readResult);
        continue;
      }

      switch (call.function.name) {
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

        // ── file writes: one scope check for all three ───────────────
        // planning may persist the spec-driven flow's artifacts (specs/plans/docs) and nothing else;
        // agent is unrestricted. Checked on EXECUTION so the model gets a readable refusal naming
        // the writable dirs, instead of a tool that mysteriously isn't offered.
        case "edit_file":
        case "rewrite_file":
        case "create_file": {
          const scope = writeScopeForMode(mode, roleWriteGlob);
          const target = String(args.file ?? args.path ?? "");
          if (!isWriteAllowed(target, workspacePath, scope)) {
            logger.logInfo(`[tools] write denied (${mode}): ${target}`);
            emitStatus(`🚫  [REI] Write blocked in ${mode} mode: ${target}`);
            toolResultsMap.set(call.id, writeDeniedMessage(target, scope, workspacePath));
            hasToolFailure = true;
            break;
          }
          if (call.function.name === "edit_file") {
            const r = handleEditFile(args, call.id, editCtx);
            if (r.toolResult) toolResultsMap.set(call.id, r.toolResult);
            if (r.failed) hasToolFailure = true;
          } else if (call.function.name === "rewrite_file") {
            const r = await handleRewriteFile(args, call.id, editCtx);
            if (r.toolResult) toolResultsMap.set(call.id, r.toolResult);
            if (r.failed) hasToolFailure = true;
          } else {
            const r = await handleCreateFile(args, editCtx);
            if (r.toolResult) toolResultsMap.set(call.id, r.toolResult);
            if (r.failed) hasToolFailure = true;
          }
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
            emitStatus(`↩️  [REI] Blocked a repeated command: ${cmd}`);
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
            // Providers that reject `/` in a function name get `__` instead; the model calls
            // back with whatever it was given, so both forms resolve here.
            const qualifiedName = fromWireToolName(call.function.name.slice(4));
            logger.logInfo(`[tools] mcp: ${qualifiedName}`);
            // Schema first: a confirm prompt for arguments the server would reject is wasted.
            const invalid = checkMcpCall(
              allMcpTools.find((t) => t.name === qualifiedName),
              args,
              invalidMcpCalls,
            );
            const refusal =
              invalid?.message ??
              (await gateMcpCall(qualifiedName, args, { allMcpTools, elicit, logger, emitStatus }));
            if (invalid) {
              logger.logInfo(`[tools] mcp args rejected: ${qualifiedName}`, {
                error: invalid.message,
                repeatBlocked: invalid.repeatBlocked,
              });
              hasToolFailure = true;
              if (invalid.repeatBlocked) blockedRepeatCount++;
            }
            if (refusal) {
              toolResult = refusal;
            } else {
              emitStatus(`🔧  [REI] Tool: ${qualifiedName}`);
              toolResult = await mcpRegistry.dispatch(qualifiedName, args);
            }
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
