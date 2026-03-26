import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "./model-provider.js";

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
        "GeminiProvider: missing API key. Set GEMINI_API_KEY environment variable or pass apiKey to the constructor."
      );
    }

    this.apiKey = apiKey;
    this.model = params?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.GEMINI_REQUEST_TIMEOUT_MS,
      DEFAULT_GEMINI_REQUEST_TIMEOUT_MS
    );
  }

  async complete(prompt: string): Promise<string> {
    return this.completeChat([{ role: "user", content: prompt }]);
  }

  async completeChat(messages: ChatMessage[]): Promise<string> {
    const response = await this.fetchJson("generateContent", messages);
    return extractGeminiText(response);
  }

  async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
    const response = await this.fetchStream(messages);

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Gemini stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`
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

  private async fetchJson(
    method: "generateContent",
    messages: ChatMessage[]
  ): Promise<GeminiGenerateContentResponse> {
    const response = await this.fetchWithTimeout(buildGeminiUrl(this.model, method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGeminiRequestBody(messages)),
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Gemini request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`
      );
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    if (data.error) {
      throw new Error(`Gemini error: ${data.error.message ?? JSON.stringify(data.error)}`);
    }

    return data;
  }

  private fetchStream(messages: ChatMessage[]): Promise<Response> {
    return this.fetchWithTimeout(buildGeminiUrl(this.model, "streamGenerateContent", true), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGeminiRequestBody(messages)),
    });
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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

function buildGeminiRequestBody(messages: ChatMessage[]): Record<string, unknown> {
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
  apiKey?: string
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
  throwOnMissing = true
): string {
  if (response.error) {
    throw new Error(`Gemini error: ${response.error.message ?? JSON.stringify(response.error)}`);
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

function parseRequestTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    return fallback;
  }
  return Math.floor(parsed);
}