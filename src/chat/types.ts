export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export type SessionMode = "ask" | "planning" | "agent";

export interface ChatSession {
  messages: ChatMessage[];
  mode: SessionMode;
  createdAt?: string;
  summary?: string;
}
