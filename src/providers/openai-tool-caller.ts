import type { ChatMessage } from "../chat/types.js";
import type {
  ToolDefinition,
  ToolCall,
  ChatCompletionWithTools,
  CompletionOptions,
} from "./model-provider.js";
import { getMaxOutputTokens, resolveAgentSampling } from "../config/model-runtime.js";
import { fetchWithRetry } from "./fetch-retry.js";

interface OpenAIToolCallResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

/**
 * Converts a ChatMessage to the OpenAI API wire format.
 * Handles the tool and assistant-with-tool_calls special cases.
 * Exported so providers can use it in their streamChat serialization,
 * enabling role:"tool" + tool_call_id round-trips on the XML path.
 */
export function toApiMessage(msg: ChatMessage): Record<string, unknown> {
  // Re-send prior reasoning only when preservation is enabled. Reasoning models
  // (e.g. qwen3.6 "Preserve Thinking") return reasoning_content as a dedicated
  // field; carrying it back gives them their prior reasoning across turns.
  const preserve = process.env.REI_PRESERVE_THINKING === "true";
  const reasoningField =
    preserve && msg.role === "assistant" && msg.reasoning_content
      ? { reasoning_content: msg.reasoning_content }
      : {};

  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content,
      tool_call_id: msg.tool_call_id ?? "",
      ...(msg.name ? { name: msg.name } : {}),
    };
  }
  if (msg.role === "assistant" && msg.tool_calls?.length) {
    return {
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.tool_calls,
      ...reasoningField,
    };
  }
  return { role: msg.role, content: msg.content, ...reasoningField };
}

/**
 * Shared completeChatWithTools implementation for OpenAI-compatible APIs.
 * Used by Ollama, OpenRouter, LLM Studio, and Groq providers.
 */
export async function openaiCompleteChatWithTools(params: {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  timeoutMs: number;
  options?: CompletionOptions;
  /** Hard output cap. Defaults to the unified REI_MAX_OUTPUT_TOKENS. */
  maxTokens?: number;
}): Promise<ChatCompletionWithTools> {
  const { baseUrl, headers, model, messages, tools, timeoutMs, options } =
    params;
  // Cap output on the tools path too (the non-tools path already does). Without
  // this, an agent turn can generate until it fills the context window — runaway
  // narration/loops. Falls back to the unified REI_MAX_OUTPUT_TOKENS.
  const maxTokens = params.maxTokens ?? getMaxOutputTokens();

  // Sampling for the tools path. Was hardcoded `temperature: 0` (greedy) — the #1 cause of
  // repetition loops on local models, and the agent is exactly where those loops hit. Now
  // provider-agnostic and configurable (REI_AGENT_*), defaulting to a mild temperature +
  // repetition penalties to prevent loops at the source. Penalties are only sent when > 0
  // (REI's "only when provided" convention), so REI_AGENT_*_PENALTY=0 omits them entirely.
  const sampling = resolveAgentSampling();

  const response = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model: options?.model ?? model,
        messages: messages.map(toApiMessage),
        tools,
        tool_choice: "auto",
        temperature: sampling.temperature,
        ...(sampling.frequencyPenalty > 0
          ? { frequency_penalty: sampling.frequencyPenalty }
          : {}),
        ...(sampling.presencePenalty > 0
          ? { presence_penalty: sampling.presencePenalty }
          : {}),
        max_tokens: maxTokens,
        stream: false,
        ...(options?.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      }),
    },
    { timeoutMs },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Tool calling request failed (${response.status} ${response.statusText})${details ? `: ${details.trim()}` : ""}`,
    );
  }

  const data = (await response.json()) as OpenAIToolCallResponse;
  if (data.error) {
    throw new Error(
      `Tool calling error: ${data.error.message ?? JSON.stringify(data.error)}`,
    );
  }

  const choice = data.choices?.[0];
  const msg = choice?.message;

  const content =
    typeof msg?.content === "string"
      ? msg.content
      : Array.isArray(msg?.content)
        ? (msg.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("")
        : "";

  const toolCalls: ToolCall[] = (msg?.tool_calls ?? [])
    .filter((tc) => tc.id && tc.function?.name)
    .map((tc) => ({
      id: tc.id!,
      type: "function" as const,
      function: {
        name: tc.function!.name!,
        arguments: tc.function!.arguments ?? "{}",
      },
    }));

  // Reasoning models (e.g. qwen3.6 in LM Studio) return their reasoning in a
  // dedicated field, separate from content — which is often empty in tool-calling
  // turns. Capture it so callers can surface/preserve it.
  const reasoning =
    (typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "") ||
    (typeof msg?.reasoning === "string" ? msg.reasoning : "") ||
    "";

  return {
    content,
    toolCalls,
    finishReason:
      choice?.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
    ...(reasoning ? { reasoning } : {}),
  };
}
