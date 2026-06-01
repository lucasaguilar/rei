import type { ChatMessage } from "../chat/types.js";
import type {
  ModelProvider,
  CompletionOptions,
  ToolDefinition,
  ChatCompletionWithTools,
} from "./model-provider.js";
import { openaiCompleteChatWithTools, toApiMessage } from "./openai-tool-caller.js";

interface GroqChatChoice {
  message?: {
    role?: string;
    content?: string | null;
  };
  finish_reason?: string;
}

interface GroqChatResponse {
  choices?: GroqChatChoice[];
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface GroqStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_GROQ_REQUEST_TIMEOUT_MS = 120_000;

export class GroqProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(params?: { apiKey?: string; model?: string }) {
    const apiKey = params?.apiKey ?? process.env.GROQ_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "GroqProvider: missing API key. Set GROQ_API_KEY environment variable or pass apiKey to the constructor.",
      );
    }
    this.apiKey = apiKey;
    this.model = params?.model ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL;
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.GROQ_REQUEST_TIMEOUT_MS,
      DEFAULT_GROQ_REQUEST_TIMEOUT_MS,
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
        `Groq request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as GroqChatResponse;
    if (data.error) {
      throw new Error(
        `Groq error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `Groq response missing message content (got ${typeof content})`,
      );
    }

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
        `Groq stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Groq stream failed: empty response body");
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
            const data = JSON.parse(payload) as GroqStreamChunk;
            if (data.error) {
              throw new Error(
                `Groq stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
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
          const data = JSON.parse(payload) as GroqStreamChunk;
          if (data.error) {
            throw new Error(
              `Groq stream error: ${data.error.message ?? JSON.stringify(data.error)}`,
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
      baseUrl: GROQ_API_BASE_URL,
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

    return fetch(`${GROQ_API_BASE_URL}/chat/completions`, {
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
