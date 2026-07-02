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
} from "./openai-tool-caller.js";

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiErrorResponse {
  error?: {
    message?: string;
    status?: string;
    code?: number;
  };
}

interface GeminiGenerateContentResponse extends GeminiErrorResponse {
  candidates?: GeminiCandidate[];
}

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// Google's OpenAI-compatibility layer — exposes /chat/completions with `tools`, so REI's shared
// OpenAI tool-caller works unchanged (same path as llmstudio/ollama/openrouter/groq).
const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GEMINI_REQUEST_TIMEOUT_MS = 120_000;

export class GeminiProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;

  constructor(params?: { apiKey?: string; model?: string }) {
    const apiKey = params?.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "GeminiProvider: missing API key. Set GEMINI_API_KEY environment variable or pass apiKey to the constructor.",
      );
    }

    this.apiKey = apiKey;
    this.model =
      params?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.GEMINI_REQUEST_TIMEOUT_MS,
      DEFAULT_GEMINI_REQUEST_TIMEOUT_MS,
    );
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    return this.completeChat([{ role: "user", content: prompt }], options);
  }

  async completeChat(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<string> {
    const response = await this.fetchJson(
      "generateContent",
      messages,
      options?.model,
    );
    return extractGeminiText(response);
  }

  async *streamChat(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<string> {
    const response = await this.fetchStream(messages, options?.model);

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Gemini stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Gemini stream failed: empty response body");
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
          if (payload) {
            const data = JSON.parse(payload) as GeminiGenerateContentResponse;
            const text = extractGeminiText(data, false);
            if (text) {
              yield text;
            }
          }
        }

        lineBreak = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing.startsWith("data: ")) {
      const payload = trailing.slice(6).trim();
      if (payload) {
        const data = JSON.parse(payload) as GeminiGenerateContentResponse;
        const text = extractGeminiText(data, false);
        if (text) {
          yield text;
        }
      }
    }
  }

  /**
   * Shared request params for both tool-calling paths via Google's OpenAI-compat endpoint.
   * The compat layer is strict and 400s on OpenAI fields REI sends by default:
   *  - top-level: the anti-loop penalties + reasoning_effort → stripped via omitParams.
   *  - per-message: `reasoning_content` (re-sent when preserve-thinking is on) → stripped here.
   *    Gemini regenerates reasoning fresh, so dropping the re-fed field loses nothing.
   */
  private geminiToolParams(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: CompletionOptions,
  ) {
    return {
      baseUrl: GEMINI_OPENAI_BASE_URL,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      model: options?.model ?? this.model,
      messages: messages.map((m) =>
        m.reasoning_content ? { ...m, reasoning_content: undefined } : m,
      ),
      tools,
      timeoutMs: this.requestTimeoutMs,
      options,
      omitParams: ["frequency_penalty", "presence_penalty", "reasoning_effort"],
    };
  }

  async completeChatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: CompletionOptions,
  ): Promise<ChatCompletionWithTools> {
    return openaiCompleteChatWithTools(
      this.geminiToolParams(messages, tools, options),
    );
  }

  async streamChatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onDelta: (delta: ToolStreamDelta) => void,
    options?: CompletionOptions,
  ): Promise<ChatCompletionWithTools> {
    return openaiStreamChatWithTools(
      this.geminiToolParams(messages, tools, options),
      onDelta,
    );
  }

  private async fetchJson(
    method: "generateContent",
    messages: ChatMessage[],
    modelOverride?: string,
  ): Promise<GeminiGenerateContentResponse> {
    const response = await this.fetchWithTimeout(
      buildGeminiUrl(modelOverride ?? this.model, method, false, this.apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildGeminiRequestBody(messages)),
      },
    );

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Gemini request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    if (data.error) {
      throw new Error(
        `Gemini error: ${data.error.message ?? JSON.stringify(data.error)}`,
      );
    }

    return data;
  }

  private fetchStream(
    messages: ChatMessage[],
    modelOverride?: string,
  ): Promise<Response> {
    return this.fetchWithTimeout(
      buildGeminiUrl(
        modelOverride ?? this.model,
        "streamGenerateContent",
        true,
        this.apiKey,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildGeminiRequestBody(messages)),
      },
    );
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildGeminiRequestBody(
  messages: ChatMessage[],
): Record<string, unknown> {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: 0,
    },
  };

  if (systemText) {
    body.systemInstruction = {
      parts: [{ text: systemText }],
    };
  }

  return body;
}

function buildGeminiUrl(
  model: string,
  method: string,
  sse = false,
  apiKey?: string,
): string {
  const endpoint = `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:${method}`;
  const query = new URLSearchParams({
    key: apiKey ?? process.env.GEMINI_API_KEY ?? "",
  });
  if (sse) {
    query.set("alt", "sse");
  }
  return `${endpoint}?${query.toString()}`;
}

function extractGeminiText(
  response: GeminiGenerateContentResponse,
  throwOnMissing = true,
): string {
  if (response.error) {
    throw new Error(
      `Gemini error: ${response.error.message ?? JSON.stringify(response.error)}`,
    );
  }

  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text && throwOnMissing) {
    throw new Error("Gemini response missing candidate text");
  }

  return text ?? "";
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
