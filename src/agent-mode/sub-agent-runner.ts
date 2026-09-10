import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "../providers/model-provider.js";
import type { AgentLogger } from "../core/logger.js";
import type { McpRegistry } from "../tools/mcp/mcp-registry.js";
import type { ElicitFn } from "../chat/elicitation.js";
import type { Role } from "../skills/role-loader.js";
import { buildProjectProfile } from "./project-profile.js";
import { resolveReasoningEffort } from "../config/model-runtime.js";
import { resolveModelForMode } from "../providers/provider-factory.js";
import {
  resolveModelTuning,
  setActiveModelTuning,
  getActiveModelTuning,
} from "../config/model-tuning.js";

/**
 * The worker model: explicit arg (or the active role's `preferredModel`) > REI_SUBAGENT_MODEL (a
 * fast, reliable executor like ornith) > the same agent model. On the same provider a different
 * model id is just a modelOverride.
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

/**
 * The framing a ROLE worker gets instead of the one above.
 *
 * Deliberately not SUB_AGENT_SYSTEM_PROMPT: that prompt tells the worker to edit and to run the
 * build, which directly contradicts a read-only posture like the auditor's ("you critique, you do
 * NOT edit"). A role brings its own instructions; all it is missing is the fact that it is running
 * blind, which is what this adds.
 */
const ROLE_SUB_AGENT_FRAMING =
  "## Execution context\n" +
  "You are running as an ISOLATED sub-agent: you do NOT see the conversation that invoked you, and " +
  "you cannot ask it anything. Work only from the task below and the files you read. If something " +
  "you need is missing, say so in your output instead of assuming it. Stay inside the role above — " +
  "its scope and output format are not negotiable. End with your result, not with narration about " +
  "what you are about to do.";

export interface SubAgentParams {
  /** The complete, self-contained task for the worker. */
  task: string;
  /** Workspace file paths the worker should read/edit (it starts fresh, so name them). */
  files?: string[];
  /** Worker model override; defaults to the role's preferredModel, then REI_SUBAGENT_MODEL. */
  model?: string;
  /**
   * A role the worker adopts: its body becomes the system prompt, and its `baseMode` + `writeGlob`
   * become the worker's permission profile.
   *
   * That second half is the point. The worker runs the same native tool loop as agent mode, so
   * without this a read-only role invoked as a sub-agent would get write access to the whole
   * repository — the exact opposite of what its own frontmatter declares.
   */
  role?: Role;
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
  const { task, files, model, role, provider, workspacePath, logger, mcpRegistry, emitStatus, elicit } =
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
  // A role's body comes FIRST: it is the worker's identity, and the framing qualifies it.
  const base = role ? `${role.body}\n\n${ROLE_SUB_AGENT_FRAMING}` : SUB_AGENT_SYSTEM_PROMPT;
  const systemContent = profile ? `${base}\n\n${profile}` : base;
  const messagesForModel: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: `${task}${filesLine}` },
  ];

  const workerModel = resolveWorkerModel(model || role?.preferredModel);
  if (workerModel) emitStatus?.(`   ↳ worker model: ${workerModel}`);

  // Swap the ACTIVE per-model tuning to the worker model for the duration of the sub-run (so its
  // sampling / context window / thinking come from ITS rei.config.json entry, not the orchestrator's),
  // then restore. See docs/model-config-spec.md + sub-agent-spec.md.
  /** Text since the last tool status — the final block is the worker's summary. */
  let tail = "";
  const prevTuning = getActiveModelTuning();
  const providerKey = (process.env.AGENT_MODEL_PROVIDER ?? process.env.MODEL_PROVIDER ?? "")
    .toLowerCase()
    .trim();
  setActiveModelTuning(resolveModelTuning(workerModel, workspacePath, providerKey || undefined));
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
      // The role's own permission profile, never a blanket "agent". A role that declares itself
      // read-only stays read-only here too — see SubAgentParams.role.
      mode: role?.baseMode ?? "agent",
      roleWriteGlob: role?.writeGlob,
      depth: 1, // sub-agent → tool-selection omits `delegate` (no nesting)
      elicit,
      onChunk: (event) => {
        if (event.type === "status") {
          emitStatus?.(event.content);
          // A TOOL status means whatever text preceded it was narration about work still to come
          // ("I'll start by reading cart.ts…"), not the summary — only the block written after the
          // last tool call is. A NOTICE is not a boundary: the output-limit continuation fires
          // mid-answer, and resetting there returned the tail of a report as the whole report.
          if (event.kind !== "notice") tail = "";
          return;
        }
        if (event.type === "text") tail += event.content;
      },
    });
    // `result.response` is the whole turn — narration included, plus REI's own "N file(s) created"
    // footer appended after streaming. Feeding that forward matters: the summary becomes the next
    // stage's only view of this one (see plan-delegation's `Depends on:` handling), so narration
    // here compounds down the plan. Fall back to the full response only when nothing streamed
    // (a non-streaming provider), where the tail would be empty rather than merely narration-free.
    const summary = (tail.trim() || (result.response ?? "").trim()).trim();
    return summary || "(sub-agent finished but produced no summary)";
  } finally {
    setActiveModelTuning(prevTuning); // restore the orchestrator's tuning
  }
}
