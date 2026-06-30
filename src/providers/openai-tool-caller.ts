import type { ChatMessage } from "../chat/types.js";
import type {
  ToolDefinition,
  ToolCall,
  ChatCompletionWithTools,
  CompletionOptions,
  ToolStreamDelta,
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
  // Default ON: preserve thinking unless explicitly disabled with REI_PRESERVE_THINKING=false.
  const preserve = process.env.REI_PRESERVE_THINKING !== "false";
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

export interface OpenAIToolsParams {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  timeoutMs: number;
  options?: CompletionOptions;
  /** Hard output cap. Defaults to the unified REI_MAX_OUTPUT_TOKENS. */
  maxTokens?: number;
}

/**
 * Builds the `/chat/completions` request body for the tools path, shared by the streaming and
 * non-streaming implementations so they can't drift. `stream` is the only thing that differs.
 *
 * Output is capped (REI_MAX_OUTPUT_TOKENS) so an agent turn can't generate until it fills the
 * context window (runaway narration/loops). Sampling is provider-agnostic + configurable
 * (REI_AGENT_*) — defaulting to a mild temperature + repetition penalties to prevent the loops that
 * a hardcoded greedy `temperature: 0` used to cause on local models. Penalties are sent only when
 * > 0 (REI's "only when provided" convention).
 */
function buildToolsRequestBody(
  params: OpenAIToolsParams,
  stream: boolean,
): Record<string, unknown> {
  const { model, messages, tools, options } = params;
  const maxTokens = params.maxTokens ?? getMaxOutputTokens();
  const sampling = resolveAgentSampling();
  return {
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
    stream,
    ...(options?.reasoningEffort
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
  };
}

/**
 * Shared completeChatWithTools implementation for OpenAI-compatible APIs.
 * Used by Ollama, OpenRouter, LLM Studio, and Groq providers.
 */
export async function openaiCompleteChatWithTools(
  params: OpenAIToolsParams,
): Promise<ChatCompletionWithTools> {
  const { baseUrl, headers, timeoutMs } = params;

  const response = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(buildToolsRequestBody(params, false)),
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

// ── Streaming tools path (spike — see docs/stream-tools-spike.md) ─────────────

/** A streamed `choices[0].delta` fragment from an OpenAI-compatible `stream:true` response. */
interface StreamChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * Accumulates streamed deltas into a final ChatCompletionWithTools. The hard part of streaming
 * tool calls: `id`/`name` arrive in the FIRST delta for a given `index`, while `arguments` stream
 * as fragments that must be concatenated PER index (a second call uses index 1, etc.). JSON args
 * are only valid once complete, so we buffer and parse nothing mid-stream. Pure + exported so it
 * can be unit-tested with canned chunks (no network). Mirrors the non-streaming assembly above.
 */
export class ToolCallAccumulator {
  private contentBuf = "";
  private reasoningBuf = "";
  private finishReason = "";
  private readonly calls = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  /** Process one streamed choice; returns the live fragment to surface (empty strings if none). */
  push(
    delta: StreamChoiceDelta,
    finishReason?: string | null,
  ): { text: string; reasoning: string } {
    let text = "";
    let reasoning = "";

    if (typeof delta.content === "string" && delta.content) {
      this.contentBuf += delta.content;
      text = delta.content;
    }
    const r =
      (typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : "") || (typeof delta.reasoning === "string" ? delta.reasoning : "");
    if (r) {
      this.reasoningBuf += r;
      reasoning = r;
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = this.calls.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (typeof tc.function?.arguments === "string")
        cur.args += tc.function.arguments;
      this.calls.set(idx, cur);
    }

    if (finishReason) this.finishReason = finishReason;
    return { text, reasoning };
  }

  /** Assemble the final result (same shape the non-streaming path returns). */
  result(): ChatCompletionWithTools {
    const toolCalls: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c)
      .filter((c) => c.id && c.name)
      .map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      }));
    return {
      content: this.contentBuf,
      toolCalls,
      finishReason:
        this.finishReason || (toolCalls.length > 0 ? "tool_calls" : "stop"),
      ...(this.reasoningBuf ? { reasoning: this.reasoningBuf } : {}),
    };
  }
}

/**
 * Streaming variant of openaiCompleteChatWithTools: posts `stream:true`, reads the SSE body, feeds
 * each `choices[0].delta` to a ToolCallAccumulator, surfaces text/reasoning fragments via `onDelta`
 * as they arrive, and resolves to the SAME ChatCompletionWithTools as the non-streaming call.
 */
export async function openaiStreamChatWithTools(
  params: OpenAIToolsParams,
  onDelta: (delta: ToolStreamDelta) => void,
): Promise<ChatCompletionWithTools> {
  const { baseUrl, headers, timeoutMs } = params;

  const response = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(buildToolsRequestBody(params, true)),
    },
    { timeoutMs },
  );

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Tool streaming request failed (${response.status} ${response.statusText})${details ? `: ${details.trim()}` : ""}`,
    );
  }
  if (!response.body) {
    throw new Error("Tool streaming response had no body.");
  }

  const acc = new ToolCallAccumulator();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE frames are newline-delimited `data: {...}` lines; a frame can straddle network chunks, so
  // we keep an incomplete tail in `buffer` and only process whole lines.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let json: {
        error?: { message?: string };
        choices?: Array<{ delta?: StreamChoiceDelta; finish_reason?: string | null }>;
      };
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore keep-alives / partial frames
      }
      if (json.error) {
        throw new Error(
          `Tool streaming error: ${json.error.message ?? JSON.stringify(json.error)}`,
        );
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      const frag = acc.push(choice.delta ?? {}, choice.finish_reason);
      if (frag.reasoning) onDelta({ type: "reasoning", content: frag.reasoning });
      if (frag.text) onDelta({ type: "text", content: frag.text });
    }
  }

  return acc.result();
}
