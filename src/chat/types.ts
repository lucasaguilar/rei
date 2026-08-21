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
 * The mode a FRESH session starts in. Reads `REI_DEFAULT_MODE` (ask|planning|agent); if unset or
 * invalid, uses the caller's `fallback` — so each entry point keeps its own historical default
 * (CLI = ask, server = agent) while a user can force one with the env var (e.g. REI_DEFAULT_MODE=agent).
 */
export function resolveDefaultSessionMode(fallback: SessionMode): SessionMode {
  const raw = process.env.REI_DEFAULT_MODE?.trim().toLowerCase();
  return raw === "ask" || raw === "planning" || raw === "agent" ? raw : fallback;
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
}
