import type { ChatMessage } from "../chat/types.js";
import type {
  ModelProvider,
  CompletionOptions,
  ToolDefinition,
  ChatCompletionWithTools,
  ToolStreamDelta,
} from "./model-provider.js";
import { toApiMessage, mergeLeadingSystemMessages } from "./openai-tool-caller.js";
import {
  openaiCompleteChatWithTools,
  openaiStreamChatWithTools,
} from "./openai-tool-caller.js";
import { getMaxOutputTokens } from "../config/model-runtime.js";
import { getActiveModelTuning } from "../config/model-tuning.js";
import { fetchWithRetry } from "./fetch-retry.js";

// ── Wire-format interfaces (OpenAI-compatible `/v1/chat/completions`) ─────

interface CompatibleChatChoice {
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
  };
  finish_reason?: string; // "stop" | "length" | ...
}

interface CompatibleChatResponse {
  choices?: CompatibleChatChoice[];
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface CompatibleStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null; // "stop" | "length" | null (null during stream)
  }>;
  error?: {
    message?: string;
  };
}

// ── Abstract base: streaming + non-streaming chat for any OpenAI-compatible
//    server (LM Studio, MTPLX, vLLM, KoboldCPP, text-generation-inference…) ─
//
// Subclasses set all fields in their constructor. This base class reads NO
// environment variables — it is purely a networking + SSE parsing engine.

export abstract class OpenAiCompatibleProvider implements ModelProvider {
  protected baseUrl!: string;
  protected apiKey!: string;
  protected model!: string;
  protected requestTimeoutMs!: number;
  protected temperature!: number;
  protected repeatPenalty?: number;
  protected frequencyPenalty!: number;
  protected presencePenalty!: number;

  /**
   * Whether this backend forwards `chat_template_kwargs` into the chat template's Jinja context.
   * Qwen3.8's reasoning level (low/medium/xhigh) is a TEMPLATE variable, not an engine param — the
   * template renders it into a system instruction. Backends that forward the field (vLLM, SGLang,
   * MTPLX) let a client set it per request; LM Studio does not (verified: an invalid value never
   * reaches the template's raise_exception), and needs a model.yaml customField instead.
   * Subclasses opt in; the base stays off so nothing new is sent to backends that would ignore it.
   */
  protected forwardsTemplateKwargs = false;

  /** The provider's default model id — lets callers resolve its per-model tuning (rei.config.json). */
  getModel(): string {
    return this.model;
  }

  /**
   * `chat_template_kwargs` for one request, or undefined when the backend doesn't forward them.
   * Kept separate from the top-level `reasoning_effort` (which is still sent): the two are
   * different doors to the same setting and backends implement one, the other, or neither.
   */
  protected templateKwargs(
    reasoningEffort?: string,
  ): Record<string, unknown> | undefined {
    if (!this.forwardsTemplateKwargs || !reasoningEffort) return undefined;
    // `none` is not a reasoning LEVEL, it is the absence of reasoning — and on a Qwen-style template
    // the two are different doors. Measured against oMLX with Qwen3.8 (medians of 3 runs, chars of
    // reasoning_content): reasoning_effort:none → 279, chat_template_kwargs{reasoning_effort:none}
    // → 280, chat_template_kwargs{enable_thinking:false} → 0. Only the last one turns it off, and it
    // overrides a top-level level sent alongside it.
    if (reasoningEffort === "none") return { enable_thinking: false };
    return { reasoning_effort: reasoningEffort };
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    return this.completeChat([{ role: "user", content: prompt }], options);
  }

  async completeChat(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<string> {
    const response = await this.fetchChat({
      messages,
      stream: false,
      modelOverride: options?.model,
      reasoningEffort: options?.reasoningEffort,
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `OpenAI-compatible request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as CompatibleChatResponse;
    if (data.error) {
      throw new Error(
        `OpenAI-compatible error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `OpenAI-compatible response missing message content (got ${typeof content})`,
      );
    }

    options?.onFinish?.(choice?.finish_reason ?? "stop");
    return content;
  }

  async *streamChat(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<string> {
    const response = await this.fetchChat({
      messages,
      stream: true,
      modelOverride: options?.model,
      reasoningEffort: options?.reasoningEffort,
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `OpenAI-compatible stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible stream failed: empty response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let lineBreak = buffer.indexOf("\n");
      while (lineBreak !== -1) {
        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);

        if (line.startsWith("data: ")) {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            return;
          }
          try {
            const data = JSON.parse(payload) as CompatibleStreamChunk;
            if (data.error) {
              throw new Error(
                `OpenAI-compatible stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
              );
            }
            const choice = data.choices?.[0];
            const delta = choice?.delta;
            const finishReason = choice?.finish_reason;
            if (finishReason) {
              options?.onFinish?.(finishReason);
            }
            const content = delta?.content || "";
            const reasoning = delta?.reasoning_content || "";
            if (reasoning) {
              yield reasoning;
            } else if (content) {
              yield content;
            }
          } catch (err) {
            if (err instanceof SyntaxError) continue;
            throw err;
          }
        }

        lineBreak = buffer.indexOf("\n");
      }
    }

    const finalLine = buffer.trim();
    if (finalLine && finalLine.startsWith("data: ")) {
      const payload = finalLine.slice(6).trim();
      if (payload !== "[DONE]") {
        try {
          const data = JSON.parse(payload) as CompatibleStreamChunk;
          if (data.error) {
            throw new Error(
              `OpenAI-compatible stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
            );
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          const finishReason = choice?.finish_reason;
          if (finishReason) {
            options?.onFinish?.(finishReason);
          }
          const content = delta?.content || "";
          const reasoning = delta?.reasoning_content || "";
          if (reasoning) {
            yield reasoning;
          } else if (content) {
            yield content;
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  }

  async completeChatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: CompletionOptions,
  ): Promise<ChatCompletionWithTools> {
    return openaiCompleteChatWithTools({
      baseUrl: this.baseUrl,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      model: this.model,
      messages,
      tools,
      timeoutMs: this.requestTimeoutMs,
      maxTokens: getMaxOutputTokens(),
      options,
      chatTemplateKwargs: this.templateKwargs(options?.reasoningEffort),
    });
  }

  async streamChatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onDelta: (delta: ToolStreamDelta) => void,
    options?: CompletionOptions,
  ): Promise<ChatCompletionWithTools> {
    return openaiStreamChatWithTools(
      {
        baseUrl: this.baseUrl,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        model: this.model,
        messages,
        tools,
        timeoutMs: this.requestTimeoutMs,
        maxTokens: getMaxOutputTokens(),
        options,
        chatTemplateKwargs: this.templateKwargs(options?.reasoningEffort),
      },
      onDelta,
    );
  }

  protected fetchChat(params: {
    messages: ChatMessage[];
    stream: boolean;
    modelOverride?: string;
    reasoningEffort?: string;
  }): Promise<Response> {
    const { messages, stream, modelOverride, reasoningEffort } = params;

    // Per-model tuning (rei.config.json) overrides the provider's env defaults on the CHAT path too
    // (ask-document, direct completeChat) — not just the agent tools path. See docs/model-config-spec.md.
    const t = getActiveModelTuning();
    const requestBody: Record<string, unknown> = {
      model: modelOverride ?? this.model,
      messages: mergeLeadingSystemMessages(messages).map(toApiMessage),
      stream,
      temperature: t?.temperature ?? this.temperature,
      max_tokens: getMaxOutputTokens(),
      frequency_penalty: t?.frequencyPenalty ?? this.frequencyPenalty,
      presence_penalty: t?.presencePenalty ?? this.presencePenalty,
    };
    if (t?.topP !== undefined) requestBody.top_p = t.topP;
    if (t?.topK !== undefined) requestBody.top_k = t.topK;
    if (t?.minP !== undefined) requestBody.min_p = t.minP;
    if (t?.repetitionPenalty !== undefined) {
      requestBody.repetition_penalty = t.repetitionPenalty;
    }
    if (this.repeatPenalty !== undefined) {
      requestBody.repeat_penalty = this.repeatPenalty;
    }
    if (reasoningEffort) {
      requestBody.reasoning_effort = reasoningEffort;
    }
    const tplKwargs = this.templateKwargs(reasoningEffort);
    if (tplKwargs) {
      requestBody.chat_template_kwargs = tplKwargs;
    }

    return fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      { timeoutMs: this.requestTimeoutMs },
    );
  }
}

// ── Shared helpers (extracted so subclasses don't duplicate) ─────────────

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function parseRequestTimeoutMs(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) return fallback;
  return Math.floor(parsed);
}

function parseFloatEnv(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) {
    return fallback;
  }
  return parsed;
}
