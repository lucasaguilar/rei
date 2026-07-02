import type { ChatMessage } from "../chat/types.js";
import type {
  ModelProvider,
  CompletionOptions,
  ToolDefinition,
  ChatCompletionWithTools,
  ToolStreamDelta,
} from "./model-provider.js";
import {
  openaiCompleteChatWithTools,
  openaiStreamChatWithTools,
  toApiMessage,
} from "./openai-tool-caller.js";

interface OpenRouterChatChoice {
  message?: {
    role?: string;
    content?: string | null | Array<{ type?: string; text?: string }>;
    reasoning?: string | null;
  };
  finish_reason?: string;
}

interface OpenRouterChatResponse {
  choices?: OpenRouterChatChoice[];
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS = 120_000;

export class OpenRouterProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(params?: { apiKey?: string; model?: string }) {
    const apiKey = params?.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "OpenRouterProvider: missing API key. Set OPENROUTER_API_KEY environment variable or pass apiKey to the constructor.",
      );
    }
    this.apiKey = apiKey;
    this.model =
      params?.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.OPENROUTER_REQUEST_TIMEOUT_MS,
      DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS,
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
        `OpenRouter request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as OpenRouterChatResponse;
    if (data.error) {
      throw new Error(
        `OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }

    const msg = data.choices?.[0]?.message;
    const text =
      extractTextContent(msg?.content) ??
      extractReasoningContent(msg?.reasoning);
    if (typeof text !== "string") {
      throw new Error(
        `OpenRouter response missing message content (got ${typeof msg?.content}): ${JSON.stringify(msg ?? data.choices?.[0] ?? data).substring(0, 300)}`,
      );
    }

    return text;
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
        `OpenRouter stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("OpenRouter stream failed: empty response body");
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
            const data = JSON.parse(payload) as OpenRouterStreamChunk;
            if (data.error) {
              throw new Error(
                `OpenRouter stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
              );
            }
            const choice = data.choices?.[0];
            const delta = choice?.delta;
            const finishReason = choice?.finish_reason;
            if (finishReason) {
              options?.onFinish?.(finishReason);
            }
            const content = delta?.content || "";
            const reasoning = delta?.reasoning || delta?.reasoning_content || "";
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
          const data = JSON.parse(payload) as OpenRouterStreamChunk;
          if (data.error) {
            throw new Error(
              `OpenRouter stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
            );
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          const finishReason = choice?.finish_reason;
          if (finishReason) {
            options?.onFinish?.(finishReason);
          }
          const content = delta?.content || "";
          const reasoning = delta?.reasoning || delta?.reasoning_content || "";
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
      baseUrl: OPENROUTER_API_BASE_URL,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      model: this.model,
      messages,
      tools,
      timeoutMs: this.requestTimeoutMs,
      options,
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
        baseUrl: OPENROUTER_API_BASE_URL,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        model: options?.model ?? this.model,
        messages,
        tools,
        timeoutMs: this.requestTimeoutMs,
        options,
      },
      onDelta,
    );
  }

  private fetchChat(params: {
    messages: ChatMessage[];
    stream: boolean;
    modelOverride?: string;
  }): Promise<Response> {
    const { messages, stream, modelOverride } = params;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    return fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: modelOverride ?? this.model,
        messages: messages.map(toApiMessage),
        stream,
        temperature: 0,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/**
 * Extract text from OpenRouter content which may be a string or an array of content parts.
 * Some models return content as [{type:"text", text:"..."}] instead of a plain string.
 */
function extractTextContent(
  content: string | null | undefined | Array<{ type?: string; text?: string }>,
): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text!);
    if (texts.length > 0) return texts.join("");
  }
  return undefined;
}

/**
 * Some reasoning models (e.g. DeepSeek-R1) return content:null with the actual
 * output in a "reasoning" field. Fall back to that when content is empty.
 */
function extractReasoningContent(
  reasoning: string | null | undefined,
): string | undefined {
  if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
  return undefined;
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
