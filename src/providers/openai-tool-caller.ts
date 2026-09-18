import type { ChatMessage } from "../chat/types.js";
import { toWireToolName } from "../contracts/mcp-tool-names.js";
import { explainBackendError } from "./backend-error.js";
import { sanitizeOpenAIUsage, type RawOpenAIUsage } from "./token-usage.js";
import type {
  ToolDefinition,
  ToolCall,
  ChatCompletionWithTools,
  CompletionOptions,
  TokenUsage,
  ToolStreamDelta,
  ToolStreamVerdict,
} from "./model-provider.js";
import {
  getMaxOutputTokens,
  resolveAgentSampling,
  preserveThinkingEnabled,
} from "../config/model-runtime.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Collapse consecutive LEADING system messages into one. REI legitimately emits two system blocks
 * (base prompt + native-tools directive), but some strict chat templates (e.g. qwen3.6) raise
 * "System message must be at the beginning" on a SECOND system message. Merging keeps the content
 * identical (concatenated with a blank line) while satisfying those templates. No-op for 0 or 1.
 */
export function mergeLeadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  let n = 0;
  while (n < messages.length && messages[n].role === "system") n += 1;
  if (n <= 1) return messages;
  const merged: ChatMessage = {
    ...messages[0],
    content: messages.slice(0, n).map((m) => m.content).join("\n\n"),
  };
  return [merged, ...messages.slice(n)];
}

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
  /** OpenAI-standard usage block (present in non-stream responses and, with `stream_options.include_usage`, the final stream chunk). */
  usage?: RawOpenAIUsage;
  error?: { message?: string };
}

/**
 * Converts a ChatMessage to the OpenAI API wire format.
 * Handles the tool and assistant-with-tool_calls special cases.
 * Exported so providers can use it in their streamChat serialization,
 * enabling role:"tool" + tool_call_id round-trips on the XML path.
 */
export function toApiMessage(msg: ChatMessage): Record<string, unknown> {
  // Re-send prior reasoning only when preservation is enabled (DEFAULT OFF — see
  // preserveThinkingEnabled). Re-feeding accumulated reasoning makes local models echo their prior
  // thoughts inside the tools loop → repetition loops.
  const preserve = preserveThinkingEnabled();
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
  /**
   * Request-body keys to strip before sending — for OpenAI-compat endpoints that reject fields the
   * spec technically allows. Gemini's compat layer, for example, 400s on `frequency_penalty` /
   * `presence_penalty` / `reasoning_effort`. Defaults to omitting nothing.
   */
  omitParams?: readonly string[];
  /**
   * Extra variables for the SERVER-SIDE chat template (`chat_template_kwargs`). Some params are not
   * engine params at all but Jinja variables the template reads — Qwen3.8's reasoning level is one:
   * the template turns `reasoning_effort` into a system-prompt instruction. Backends differ on how
   * they let a client reach that context: vLLM/SGLang/MTPLX forward `chat_template_kwargs`, while
   * LM Studio drops it (it needs a model.yaml customField instead). Providers whose backend forwards
   * it set this; the rest leave it undefined and the field is never sent.
   */
  chatTemplateKwargs?: Record<string, unknown>;
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
/**
 * Reduces a tool definition to the fields the OpenAI tools API defines.
 *
 * `ToolDefinition` carries REI's own bookkeeping alongside the wire shape — `modelFeedback` marks
 * whether a result must go back to the model. Sending the whole object worked against permissive
 * backends and failed hard against strict ones: Gemini validates the payload and rejected the
 * request outright, once per MCP tool —
 *
 *     Unknown name "modelFeedback" at 'tools[9]': Cannot find field.
 *
 * — which reads as "MCP is broken with Gemini" rather than "REI leaked an internal field". The wire
 * shape is built explicitly here so a future internal field cannot leak the same way.
 */
function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: tool.type,
    function: {
      name: toWireToolName(tool.function.name),
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

function buildToolsRequestBody(
  params: OpenAIToolsParams,
  stream: boolean,
): Record<string, unknown> {
  const { model, messages, tools, options } = params;
  const maxTokens = params.maxTokens ?? getMaxOutputTokens();
  const sampling = resolveAgentSampling();
  const body: Record<string, unknown> = {
    model: options?.model ?? model,
    messages: mergeLeadingSystemMessages(messages).map(toApiMessage),
    tools: tools.map(toWireTool),
    tool_choice: "auto",
    temperature: sampling.temperature,
    ...(sampling.frequencyPenalty > 0
      ? { frequency_penalty: sampling.frequencyPenalty }
      : {}),
    ...(sampling.presencePenalty > 0
      ? { presence_penalty: sampling.presencePenalty }
      : {}),
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
    // min_p / repetition_penalty reached only the non-tools chat path before, so a per-model block
    // configuring them was silently inert in AGENT mode — the one place loops actually bite.
    ...(sampling.minP !== undefined ? { min_p: sampling.minP } : {}),
    ...(sampling.repetitionPenalty !== undefined
      ? { repetition_penalty: sampling.repetitionPenalty }
      : {}),
    max_tokens: maxTokens,
    stream,
    // Real token counts on the streaming path (OpenAI sends a final usage-only chunk).
    // Backends that 400 on this field can strip it via omitParams.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(options?.reasoningEffort
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
    ...(params.chatTemplateKwargs &&
    Object.keys(params.chatTemplateKwargs).length > 0
      ? { chat_template_kwargs: params.chatTemplateKwargs }
      : {}),
  };
  // Drop fields a specific compat endpoint rejects (e.g. Gemini 400s on frequency_penalty).
  for (const key of params.omitParams ?? []) delete body[key];
  return body;
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
    // A local backend answers with ITS error — for MLX, a Python traceback from inside
    // `.lmstudio/extensions`. explainBackendError rewrites the two failures whose cause is known
    // (out of GPU memory, cancelled model load) and passes everything else through untouched.
    throw new Error(
      `Tool calling request failed (${response.status} ${response.statusText})${
        details ? `: ${explainBackendError(details.trim())}` : ""
      }`,
    );
  }

  const data = (await response.json()) as OpenAIToolCallResponse;
  if (data.error) {
    throw new Error(
      `Tool calling error: ${explainBackendError(data.error.message ?? JSON.stringify(data.error))}`,
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

  const usage = sanitizeOpenAIUsage(data.usage);

  return {
    content,
    toolCalls,
    finishReason:
      choice?.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
    ...(reasoning ? { reasoning } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
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
  private usage: TokenUsage = {};
  private readonly calls = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  private stoppedEarly?: "repetition";

  /** Marks the response as cut short by a consumer (the loop guard), not by the model. */
  markStoppedEarly(reason: "repetition"): void {
    this.stoppedEarly = reason;
  }

  /** Records the backend-reported usage (from the final stream chunk); no-op when it reports nothing valid. */
  setUsage(raw?: RawOpenAIUsage): void {
    this.usage = sanitizeOpenAIUsage(raw);
  }

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
      // A stream cut by the guard has no finish_reason from the backend: it is reported as `stop`
      // so the tools loop treats it as a plain end-of-answer, with `stoppedEarly` carrying WHY —
      // a half-built tool call in a runaway generation must not be run.
      finishReason:
        this.finishReason ||
        (this.stoppedEarly ? "stop" : toolCalls.length > 0 ? "tool_calls" : "stop"),
      ...(this.reasoningBuf ? { reasoning: this.reasoningBuf } : {}),
      ...(Object.keys(this.usage).length > 0 ? { usage: this.usage } : {}),
      ...(this.stoppedEarly ? { stoppedEarly: this.stoppedEarly } : {}),
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
      `Tool streaming request failed (${response.status} ${response.statusText})${
        details ? `: ${explainBackendError(details.trim())}` : ""
      }`,
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
        usage?: RawOpenAIUsage;
        choices?: Array<{ delta?: StreamChoiceDelta; finish_reason?: string | null }>;
      };
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore keep-alives / partial frames
      }
      if (json.error) {
        throw new Error(
          `Tool streaming error: ${explainBackendError(json.error.message ?? JSON.stringify(json.error))}`,
        );
      }
      // With stream_options.include_usage, OpenAI sends the counts in a FINAL chunk whose
      // choices array is empty — capture it before skipping choice-less chunks.
      if (json.usage) acc.setUsage(json.usage);
      const choice = json.choices?.[0];
      if (!choice) continue;
      const frag = acc.push(choice.delta ?? {}, choice.finish_reason);
      // A consumer answering "stop" ends the stream here: cancel the body (which closes the
      // connection, so the backend stops generating too) and return what has arrived. Used by the
      // loop guard — see ToolStreamVerdict.
      // `void | "stop"` keeps plain void callbacks assignable; reading the answer needs the
      // narrower view of the same value.
      const asVerdict = (v: ToolStreamVerdict): "stop" | undefined =>
        v as "stop" | undefined;
      let verdict: "stop" | undefined;
      if (frag.reasoning)
        verdict = asVerdict(onDelta({ type: "reasoning", content: frag.reasoning }));
      if (frag.text)
        verdict = asVerdict(onDelta({ type: "text", content: frag.text })) ?? verdict;
      if (verdict === "stop") {
        await reader.cancel().catch(() => {});
        acc.markStoppedEarly("repetition");
        return acc.result();
      }
    }
  }

  return acc.result();
}
