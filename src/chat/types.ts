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
}

export type SessionMode = "ask" | "planning" | "agent";

export interface ChatSession {
  messages: ChatMessage[];
  mode: SessionMode;
  createdAt?: string;
  summary?: string;
  /** Workspace-relative (or absolute) path to the OCR/text doc that /ask-document targets by
   *  default. Auto-set when a document finishes OCR; changed via /doc; cleared by /doc clear.
   *  Session-scoped (a new session starts with none). Single doc for now; multi-doc is future. */
  activeDocument?: string;
}
