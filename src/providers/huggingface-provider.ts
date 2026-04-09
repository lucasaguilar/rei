import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, CompletionOptions } from "./model-provider.js";

interface HFChatChoice {
  message?: { role?: string; content?: string | null };
  finish_reason?: string;
}

interface HFChatResponse {
  choices?: HFChatChoice[];
  error?: string;
}

interface HFStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

// HuggingFace Serverless Inference API — OpenAI-compatible endpoint
// Docs: https://huggingface.co/docs/api-inference/tasks/chat-completion
const HF_API_BASE_URL = "https://router.huggingface.co/v1";
const DEFAULT_HF_MODEL = "Qwen/Qwen2.5-72B-Instruct";
const DEFAULT_HF_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HF_MAX_TOKENS = 8192;

export class HuggingFaceProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly maxTokens: number;

  constructor(params?: { apiKey?: string; model?: string }) {
    const apiKey = params?.apiKey ?? process.env.HF_TOKEN ?? "";
    if (!apiKey) {
      throw new Error(
        "HuggingFaceProvider: missing API key. Set HF_TOKEN environment variable or pass apiKey to the constructor.",
      );
    }
    this.apiKey = apiKey;
    this.model = params?.model ?? process.env.HF_MODEL ?? DEFAULT_HF_MODEL;
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.HF_REQUEST_TIMEOUT_MS,
      DEFAULT_HF_REQUEST_TIMEOUT_MS,
    );
    this.maxTokens = parsePositiveInt(
      process.env.HF_MAX_TOKENS,
      DEFAULT_HF_MAX_TOKENS,
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
        `HuggingFace request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as HFChatResponse;
    if (data.error) {
      throw new Error(`HuggingFace error: ${data.error}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `HuggingFace response missing message content (got ${typeof content})`,
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
        `HuggingFace stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("HuggingFace stream failed: empty response body");
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
            const data = JSON.parse(payload) as HFStreamChunk;
            const content = data.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch (err) {
            if (err instanceof SyntaxError) continue;
            throw err;
          }
        }

        lineBreak = buffer.indexOf("\n");
      }
    }

    const finalLine = buffer.trim();
    if (finalLine.startsWith("data: ")) {
      const payload = finalLine.slice(6).trim();
      if (payload !== "[DONE]") {
        try {
          const data = JSON.parse(payload) as HFStreamChunk;
          const content = data.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  }

  private fetchChat(params: {
    messages: ChatMessage[];
    stream: boolean;
    modelOverride?: string;
  }): Promise<Response> {
    const { messages, stream, modelOverride } = params;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const wantsJson = shouldHintJsonResponse(messages);
    const body: Record<string, unknown> = {
      model: modelOverride ?? this.model,
      messages,
      stream,
      temperature: 0,
      max_tokens: this.maxTokens,
    };
    if (wantsJson) {
      body.response_format = { type: "json_object" };
    }

    return fetch(`${HF_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseRequestTimeoutMs(
  envValue: string | undefined,
  defaultMs: number,
): number {
  if (!envValue) return defaultMs;
  const parsed = parseInt(envValue, 10);
  return isNaN(parsed) || parsed <= 0 ? defaultMs : parsed;
}

function parsePositiveInt(
  envValue: string | undefined,
  fallback: number,
): number {
  if (!envValue) return fallback;
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldHintJsonResponse(messages: ChatMessage[]): boolean {
  // Important: only force JSON mode for explicit internal repair/synthesis prompts.
  // If this is too broad, user-facing final answers can become raw JSON.
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUser) return false;

  const prompt = lastUser.content.toLowerCase();
  return (
    prompt.includes("return only json") ||
    prompt.includes("return json only") ||
    prompt.includes("valid json") ||
    prompt.includes("first character must be {") ||
    prompt.includes("no markdown fences") ||
    prompt.includes("proposedpatches must be")
  );
}
