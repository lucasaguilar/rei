import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";
import type { ElicitFn } from "../../chat/elicitation.js";
import { runSubAgent } from "../sub-agent-runner.js";

export interface DelegateCtx {
  provider: ModelProvider;
  workspacePath: string;
  logger: AgentLogger;
  mcpRegistry?: McpRegistry;
  emitStatus: (msg: string) => void;
  elicit?: ElicitFn;
}

/**
 * delegate → run a self-contained subtask in an isolated-context sub-agent and return its compact
 * summary to the orchestrator (the worker's file edits already landed on disk). See sub-agent-runner.
 */
export async function handleDelegate(
  args: { task?: unknown; files?: unknown },
  ctx: DelegateCtx,
): Promise<string> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) return "ERROR: delegate requires a non-empty 'task'.";
  const files = Array.isArray(args.files)
    ? (args.files.filter((f) => typeof f === "string" && f.trim()) as string[])
    : undefined;

  ctx.logger.logInfo(`[tools] delegate: "${task}"`, { files });
  const short = task.length > 80 ? `${task.slice(0, 79)}…` : task;
  ctx.emitStatus(`🤖  [REI] Delegando a sub-agente: ${short}`);

  const summary = await runSubAgent({
    task,
    files,
    provider: ctx.provider,
    workspacePath: ctx.workspacePath,
    logger: ctx.logger,
    mcpRegistry: ctx.mcpRegistry,
    emitStatus: ctx.emitStatus,
    elicit: ctx.elicit,
  });

  ctx.emitStatus(`   ↳ sub-agente terminó.`);
  return `Sub-agent completed the delegated task. Its summary:\n${summary}`;
}
