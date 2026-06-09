import type { ChatMessage } from "../chat/types.js";

export interface CompletionOptions {
  model?: string;
  /** Called when generation finishes. reason is "stop", "length" (truncated), "tool_calls", etc. */
  onFinish?: (reason: string) => void;
}

// ── Structured tool calling ──────────────────────────────────────────────────

export interface ToolParameterSchema {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  items?: ToolParameterSchema;
  required?: string[];
  enum?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterSchema>;
      required: string[];
    };
  };
  /**
   * When true, the tool result must be fed back to the model so it can act on
   * it (e.g. MCP tools that chain multiple calls before producing an edit).
   * When false or absent, the result is shown to the user only (fire-and-forget,
   * e.g. weather, web search).
   */
  modelFeedback?: boolean;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded string
  };
}

export interface ChatCompletionWithTools {
  content: string;        // text portion of the response (may be empty)
  toolCalls: ToolCall[];  // structured tool calls (may be empty)
  finishReason: string;   // "stop" | "tool_calls" | "length" | ...
  reasoning?: string;     // model reasoning (reasoning_content) — present for reasoning models
                          // even when content is empty (e.g. qwen3.6 in tool-calling mode)
}

// ── Provider interface ───────────────────────────────────────────────────────

export interface ModelProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  completeChat(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
  streamChat?(messages: ChatMessage[], options?: CompletionOptions): AsyncIterable<string>;
  /** Structured function/tool calling. Optional — providers that don't support it return undefined. */
  completeChatWithTools?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: CompletionOptions,
  ): Promise<ChatCompletionWithTools>;
}
