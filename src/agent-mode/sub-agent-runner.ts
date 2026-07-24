import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentLogger } from "../core/logger.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import type { ElicitFn } from "../chat/elicitation.js";
import { buildProjectProfile } from "./project-profile.js";
import { resolveReasoningEffort } from "../config/model-runtime.js";
import { resolveModelForMode } from "../providers/provider-factory.js";
import {
  resolveModelTuning,
  setActiveModelTuning,
  getActiveModelTuning,
} from "../config/model-tuning.js";

/**
 * The worker model: explicit arg (Phase 3) > REI_SUBAGENT_MODEL (a fast, reliable executor like
 * ornith) > the same agent model. On the same provider a different model id is just a modelOverride.
 */
export function resolveWorkerModel(explicit?: string): string | undefined {
  const configured = process.env.REI_SUBAGENT_MODEL?.trim();
  return explicit || configured || resolveModelForMode("agent");
}

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
  "do NOT see the orchestrator's conversation — work only from the task and the project conventions " +
  "below. Read the files you need (read_files), then make the edits FOLLOWING the project conventions " +
  "(module system, language, style). VERIFY before finishing: if you wrote a script, run it; if you " +
  "changed code, run the build/test. Do NOT explore beyond the task or ask about the broader goal. " +
  "When done, reply with a SHORT summary (1-3 sentences) of what you changed and which files.";

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
  // Inject the project profile so the isolated worker follows repo conventions (ESM/CJS, TS, style)
  // it can't see from the orchestrator's history. See project-profile.ts.
  const profile = buildProjectProfile(workspacePath);
  const systemContent = profile
    ? `${SUB_AGENT_SYSTEM_PROMPT}\n\n${profile}`
    : SUB_AGENT_SYSTEM_PROMPT;
  const messagesForModel: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: `${task}${filesLine}` },
  ];

  const workerModel = resolveWorkerModel(model);
  if (workerModel) emitStatus?.(`   ↳ worker model: ${workerModel}`);

  // Swap the ACTIVE per-model tuning to the worker model for the duration of the sub-run (so its
  // sampling / context window / thinking come from ITS rei.config.json entry, not the orchestrator's),
  // then restore. See docs/model-config-spec.md + sub-agent-spec.md.
  const prevTuning = getActiveModelTuning();
  setActiveModelTuning(resolveModelTuning(workerModel, workspacePath));
  try {
    const result = await executeAgentTurnWithTools({
      provider,
      messagesForModel,
      workspacePath,
      logger,
      modelOverride: workerModel,
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
  } finally {
    setActiveModelTuning(prevTuning); // restore the orchestrator's tuning
  }
}
