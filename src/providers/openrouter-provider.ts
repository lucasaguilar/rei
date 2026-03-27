import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "./model-provider.js";

interface OpenRouterChatChoice {
  message?: {
    role?: string;
    content?: string | null;
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
    delta?: { content?: string };
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
        "OpenRouterProvider: missing API key. Set OPENROUTER_API_KEY environment variable or pass apiKey to the constructor."
      );
    }
    this.apiKey = apiKey;
    this.model =
      params?.model ??
      process.env.OPENROUTER_MODEL ??
      DEFAULT_OPENROUTER_MODEL;
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.OPENROUTER_REQUEST_TIMEOUT_MS,
      DEFAULT_OPENROUTER_REQUEST_TIMEOUT_MS
    );
  }

  async complete(prompt: string): Promise<string> {
    return this.completeChat([{ role: "user", content: prompt }]);
  }

  async completeChat(messages: ChatMessage[]): Promise<string> {
    const response = await this.fetchChat({ messages, stream: false });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `OpenRouter request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`
      );
    }

    const data = (await response.json()) as OpenRouterChatResponse;
    if (data.error) {
      throw new Error(
        `OpenRouter error: ${data.error.message ?? JSON.stringify(data.error)}`
      );
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `OpenRouter response missing message content (got ${typeof content})`
      );
    }

    return content;
  }

  async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
    const response = await this.fetchChat({ messages, stream: true });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `OpenRouter stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`
      );
    }

    if (!response.body) {
      throw new Error("OpenRouter stream failed: empty response body");
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
          if (payload === "[DONE]") return;
          try {
            const data = JSON.parse(payload) as OpenRouterStreamChunk;
            if (data.error) {
              throw new Error(
                `OpenRouter stream error: ${data.error.message ?? JSON.stringify(data.error)}`
              );
            }
            const content = data.choices?.[0]?.delta?.content;
            if (content) {
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
              `OpenRouter stream error: ${data.error.message ?? JSON.stringify(data.error)}`
            );
          }
          const content = data.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) {
            throw err;
          }
        }
      }
    }
  }

  private fetchChat(params: {
    messages: ChatMessage[];
    stream: boolean;
  }): Promise<Response> {
    const { messages, stream } = params;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs
    );

    return fetch(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
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
  fallback: number
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    return fallback;
  }
  return Math.floor(parsed);
}
