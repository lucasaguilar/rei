import type { ToolCall } from "../providers/model-provider.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Model reasoning (reasoning_content) for assistant messages from reasoning
   *  models. Stored separately from content; only re-sent to the API when
   *  REI_PRESERVE_THINKING=true (see toApiMessage). */
  reasoning_content?: string;
  /** Structured tool calls emitted by the assistant (function calling). */
  tool_calls?: ToolCall[];
  /** ID matching the tool call this result belongs to (role: "tool"). */
  tool_call_id?: string;
  /** Tool name for role: "tool" messages. */
  name?: string;
  /** The session mode that produced this message. Used to preserve planning
   *  responses in agent-mode context (they contain implementation plans). */
  sourceMode?: SessionMode;
  /** ID of the turn that produced this message. All messages of one turn (the user prompt plus the
   *  assistant/tool messages it generated) share it, so the flat `messages[]` becomes segmentable
   *  for navigation and detour-pruning. Reuses the AgentLogger turnId, so it also correlates a
   *  session with its `agent-flow.jsonl` entries. Optional: older sessions simply lack it.
   *  See docs/context-drift-spec.md. */
  turnId?: string;
  /** Marked as an off-topic detour via `/tree prune`. Pruned messages stay on disk (recoverable
   *  with `/tree keep`) but are excluded from what's sent to the model, so a tangent stops diluting
   *  the working context. Whole turns are pruned together, so user/assistant/tool pairs stay intact.
   *  See docs/context-drift-spec.md. */
  pruned?: boolean;
}

export type SessionMode = "ask" | "planning" | "agent";

/**
 * The mode a FRESH session starts in. Default is "agent" — REI starts ready to act, no config needed.
 * Override with `REI_DEFAULT_MODE` (ask|planning|agent) if you'd rather start read-only.
 */
export function resolveDefaultSessionMode(): SessionMode {
  const raw = process.env.REI_DEFAULT_MODE?.trim().toLowerCase();
  if (raw === "ask" || raw === "planning" || raw === "agent") return raw;
  return "agent";
}

export interface ChatSession {
  messages: ChatMessage[];
  mode: SessionMode;
  createdAt?: string;
  summary?: string;
  /** Workspace-relative (or absolute) path to the OCR/text doc that /ask-document targets by
   *  default. Auto-set when a document finishes OCR; changed via /doc; cleared by /doc clear.
   *  Session-scoped (a new session starts with none). Single doc for now; multi-doc is future. */
  activeDocument?: string;
  /** Active data-driven role (e.g. "auditor") — a posture layered on `mode`, loaded from
   *  prompts/roles/<name>.md. Its body is injected into the system prompt. See docs/roles-spec.md. */
  activeRole?: string;
  /**
   * The mode you were in before a role took over, so `/role off` puts you back.
   *
   * A role adopts its own `baseMode`, so activating one silently moved you (agent → planning) and
   * leaving it left you there — with `/role off` reporting "back to the plain mode", which reads
   * as if it had returned you where you started. In-memory like `activeRole`: a role does not
   * survive a session reload, so neither should the mode it displaced.
   */
  rolePreviousMode?: SessionMode;
  /**
   * A model chosen by hand with `/model`, which outranks an active role's `preferredModel`.
   *
   * The rule is **the most recent explicit choice wins**: activating a role and typing `/model` are
   * both deliberate, so ordering them by recency is the only rule that never surprises. Cleared
   * when a role is activated — that is a new decision about the model — so `/role X` always returns
   * you to X's model. In-memory, like `activeRole`.
   *
   * Without it, `/model` reported success and changed nothing while a role was active.
   */
  manualModel?: string;
  /**
   * WHICH model slot `manualModel` was chosen for: `"agent"` for `/model agent x`, `"base"` for
   * `/model x` — mirroring the env split (`<PREFIX>_MODEL_AGENT` vs `<PREFIX>_MODEL`), because that
   * is the split `/model` itself writes to.
   *
   * Without it the field was session-wide, so a choice made for one slot silently governed the
   * other: `/model agent X` then `/mode ask` ran ask on X and the status bar named it, while the
   * ask model sat unused. `/model` already refused to record a choice that did not target the mode
   * you were in (`targetsThisMode`) — this is that same rule, remembered instead of checked once.
   */
  manualModelScope?: "agent" | "base";
}
