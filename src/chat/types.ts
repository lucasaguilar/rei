export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
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
}
