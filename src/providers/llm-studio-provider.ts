import type { ChatMessage } from "../chat/types.js";
import type {
  ModelProvider,
  CompletionOptions,
  ToolDefinition,
  ChatCompletionWithTools,
} from "./model-provider.js";
import { openaiCompleteChatWithTools, toApiMessage } from "./openai-tool-caller.js";

interface LlmStudioChatChoice {
  message?: {
    role?: string;
    content?: string | null;
  };
  finish_reason?: string; // "stop" | "length" | ...
}

interface LlmStudioChatResponse {
  choices?: LlmStudioChatChoice[];
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface LlmStudioStreamChunk {
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

const DEFAULT_LLM_STUDIO_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_LLM_STUDIO_REQUEST_TIMEOUT_MS = 600_000; // 10 minutes fallback for local inference
// Hard cap on output tokens. Without this, a reasoning model that enters a
// degenerate loop will keep generating until the request timeout (10 min).
// 8192 is generous for normal responses but stops runaway "thinking forever".
const DEFAULT_LLM_STUDIO_MAX_TOKENS = 8192;
// Greedy decoding (temperature 0) is the most common cause of repetition loops
// ("I will write the response... I will write the response..."). LM Studio's own
// chat UI uses a non-zero default (~0.6), which is why it doesn't loop. Match that.
// Override with LLM_STUDIO_TEMPERATURE=0 if you need fully deterministic output.
const DEFAULT_LLM_STUDIO_TEMPERATURE = 0.6;
// Optional second anti-loop lever. Left UNSET by default so LM Studio uses its own
// configured repeat_penalty (the one that already works in its chat UI). Only sent
// to the API when LLM_STUDIO_REPEAT_PENALTY is explicitly provided.
//
// OpenAI-standard repetition penalties. Unlike temperature (random noise), these
// directly lower the probability of tokens that ALREADY appeared, which is the
// correct lever against structured cyclic repetition ("I will check X. I will
// check Y. I will check X. I will check Y..."). LM Studio supports both.
const DEFAULT_LLM_STUDIO_FREQUENCY_PENALTY = 0.3;
const DEFAULT_LLM_STUDIO_PRESENCE_PENALTY = 0.3;

export class LlmStudioProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly repeatPenalty?: number;
  private readonly frequencyPenalty: number;
  private readonly presencePenalty: number;

  constructor(params?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.LLM_STUDIO_BASE_URL ?? DEFAULT_LLM_STUDIO_BASE_URL,
    );
    this.apiKey = params?.apiKey ?? process.env.LLM_STUDIO_API_KEY ?? "lm-studio";
    this.model = params?.model ?? process.env.LLM_STUDIO_MODEL ?? "";
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.LLM_STUDIO_REQUEST_TIMEOUT_MS,
      DEFAULT_LLM_STUDIO_REQUEST_TIMEOUT_MS,
    );
    this.maxTokens = parseMaxTokens(
      process.env.LLM_STUDIO_MAX_TOKENS,
      DEFAULT_LLM_STUDIO_MAX_TOKENS,
    );
    this.temperature = parseFloatEnv(
      process.env.LLM_STUDIO_TEMPERATURE,
      DEFAULT_LLM_STUDIO_TEMPERATURE,
      { min: 0, max: 2 },
    );
    // Only set when explicitly provided — otherwise we let LM Studio use its own default.
    this.repeatPenalty = process.env.LLM_STUDIO_REPEAT_PENALTY
      ? parseFloatEnv(process.env.LLM_STUDIO_REPEAT_PENALTY, 1.1, { min: 1, max: 2 })
      : undefined;
    this.frequencyPenalty = parseFloatEnv(
      process.env.LLM_STUDIO_FREQUENCY_PENALTY,
      DEFAULT_LLM_STUDIO_FREQUENCY_PENALTY,
      { min: 0, max: 2 },
    );
    this.presencePenalty = parseFloatEnv(
      process.env.LLM_STUDIO_PRESENCE_PENALTY,
      DEFAULT_LLM_STUDIO_PRESENCE_PENALTY,
      { min: 0, max: 2 },
    );
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
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `LLM Studio request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as LlmStudioChatResponse;
    if (data.error) {
      throw new Error(
        `LLM Studio error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `LLM Studio response missing message content (got ${typeof content})`,
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
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `LLM Studio stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("LLM Studio stream failed: empty response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let inThinking = false;

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let lineBreak = buffer.indexOf("\n");
      while (lineBreak !== -1) {
        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);

        if (line.startsWith("data: ")) {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            if (inThinking) {
              yield "</think>";
            }
            return;
          }
          try {
            const data = JSON.parse(payload) as LlmStudioStreamChunk;
            if (data.error) {
              throw new Error(
                `LLM Studio stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
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
              if (!inThinking) {
                yield "<think>";
                inThinking = true;
              }
              yield reasoning;
            } else if (content) {
              if (inThinking) {
                yield "</think>";
                inThinking = false;
              }
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
          const data = JSON.parse(payload) as LlmStudioStreamChunk;
          if (data.error) {
            throw new Error(
              `LLM Studio stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
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
            if (!inThinking) {
              yield "<think>";
              inThinking = true;
            }
            yield reasoning;
          } else if (content) {
            if (inThinking) {
              yield "</think>";
              inThinking = false;
            }
            yield content;
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) {
            throw err;
          }
        }
      }
    }

    if (inThinking) {
      yield "</think>";
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
      options,
    });
  }

  private fetchChat(params: {
    messages: ChatMessage[];
    stream: boolean;
    modelOverride?: string;
  }): Promise<Response> {
    const { messages, stream, modelOverride } = params;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const requestBody: Record<string, unknown> = {
      model: modelOverride ?? this.model,
      messages: messages.map(toApiMessage),
      stream,
      temperature: this.temperature,          // non-zero to avoid greedy repetition loops
      max_tokens: this.maxTokens,             // hard cap — prevents runaway generation
      frequency_penalty: this.frequencyPenalty, // penalize repeated tokens (anti-cycle)
      presence_penalty: this.presencePenalty,   // penalize already-seen tokens (anti-cycle)
    };
    // Only override LM Studio's own repeat_penalty when explicitly configured.
    if (this.repeatPenalty !== undefined) {
      requestBody.repeat_penalty = this.repeatPenalty;
    }

    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  }
}

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
  if (!Number.isFinite(parsed) || parsed < 1000) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseMaxTokens(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  // Reject non-numeric / non-positive values; 0 or negative would break the request.
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
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