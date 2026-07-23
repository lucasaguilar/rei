import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentLogger } from "../core/logger.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import type { ElicitFn } from "../chat/elicitation.js";
import { resolveReasoningEffort } from "../config/model-runtime.js";
import { resolveModelForMode } from "../providers/provider-factory.js";

/**
 * Runs a delegated subtask in an ISOLATED context — a fresh session that does NOT inherit the
 * orchestrator's accumulated history, and returns only a compact summary. This is the local-model
 * optimization: the worker gets a clean small window, and the orchestrator's context grows by only
 * the summary (not the worker's exploration). See docs/sub-agent-spec.md.
 *
 * Phase 1: same model (unless a worker model is passed), depth-1 (the worker has no `delegate` tool,
 * gated in tool-selection). The worker reuses the full native tool loop — its edits land on disk
 * (direct mode), so no result marshaling beyond the summary is needed.
 */

const SUB_AGENT_SYSTEM_PROMPT =
  "You are a focused sub-agent executing ONE self-contained task delegated by an orchestrator. You " +
  "do NOT see the orchestrator's conversation — work only from the task below. Read the files you " +
  "need (read_files), make the edits, and verify. Do NOT explore beyond the task or ask about the " +
  "broader goal. When done, reply with a SHORT summary (1-3 sentences) of what you changed and which " +
  "files, so the orchestrator can continue.";

export interface SubAgentParams {
  /** The complete, self-contained task for the worker. */
  task: string;
  /** Workspace file paths the worker should read/edit (it starts fresh, so name them). */
  files?: string[];
  /** Worker model override; Phase 1 defaults to the same agent model. */
  model?: string;
  provider: ModelProvider;
  workspacePath: string;
  logger: AgentLogger;
  mcpRegistry?: McpRegistry;
  /** Forwards the worker's live status to the user (so delegation isn't a black box). */
  emitStatus?: (msg: string) => void;
  /** Passed through so the worker's destructive-command gate still confirms with the user. */
  elicit?: ElicitFn;
}

export async function runSubAgent(params: SubAgentParams): Promise<string> {
  const { task, files, model, provider, workspacePath, logger, mcpRegistry, emitStatus, elicit } =
    params;

  // Dynamic import breaks the static cycle (generator-tools → dispatch → delegate-handler → here).
  const { executeAgentTurnWithTools } = await import("./generator-tools.js");

  const filesLine =
    files && files.length > 0
      ? `\n\nRelevant files (read them with read_files before editing): ${files.join(", ")}`
      : "";
  const messagesForModel: ChatMessage[] = [
    { role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
    { role: "user", content: `${task}${filesLine}` },
  ];

  const result = await executeAgentTurnWithTools({
    provider,
    messagesForModel,
    workspacePath,
    logger,
    modelOverride: model || resolveModelForMode("agent"),
    reasoningEffort: resolveReasoningEffort("agent"),
    mcpRegistry,
    userQuery: task,
    mode: "agent",
    depth: 1, // sub-agent → tool-selection omits `delegate` (no nesting)
    elicit,
    onChunk: (event) => {
      if (event.type === "status") emitStatus?.(event.content);
    },
  });

  const summary = (result.response ?? "").trim();
  return summary || "(sub-agent finished but produced no summary)";
}
