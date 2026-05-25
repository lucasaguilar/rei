import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider, CompletionOptions } from "./model-provider.js";

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    thinking?: string; // Ollama 0.6+: thinking models stream reasoning here
  };
  error?: string;
  done?: boolean;
}

const OLLAMA_FETCH_MAX_RETRIES = 1;
const OLLAMA_FETCH_RETRY_DELAY_MS = 900;
const DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_OLLAMA_KEEP_ALIVE = "30m";

export class OllamaProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestTimeoutMs: number;
  private readonly keepAlive: string;
  private readonly ollamaOptions: OllamaRequestOptions;

  constructor(params?: { baseUrl?: string; model?: string }) {
    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ??
        process.env.OLLAMA_BASE_URL ??
        "http://127.0.0.1:11434",
    );
    this.model = params?.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.OLLAMA_REQUEST_TIMEOUT_MS,
      DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS,
    );
    this.keepAlive = process.env.OLLAMA_KEEP_ALIVE ?? DEFAULT_OLLAMA_KEEP_ALIVE;
    this.ollamaOptions = buildOllamaRequestOptions();
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
      operation: "request",
      modelOverride: options?.model,
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Ollama request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const content = data.message?.content;
    if (typeof content !== "string") {
      const sanitizedDetails = JSON.stringify({
        hasMessage: !!data.message,
        hasContentProperty:
          data.message != null &&
          Object.prototype.hasOwnProperty.call(data.message, "content"),
        contentType: typeof content,
      });
      throw new Error(
        `Ollama response missing message content or content is not a string: ${sanitizedDetails}`,
      );
    }

    // Empty content on thinking models means num_predict was exhausted by the
    // <think> block. Raise num_predict (32768+ for 35B thinking models).
    if (!content.trim()) {
      const hasThinking = !!data.message?.thinking;
      const hint = hasThinking
        ? `Model used all tokens on thinking. Increase OLLAMA_NUM_PREDICT (32768+ recommended for thinking models).`
        : `Check OLLAMA_NUM_PREDICT (recommended: 16384+).`;
      throw new Error(
        `Ollama returned empty response. ${hint} Current model: ${options?.model ?? this.model}`,
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
      operation: "stream",
      modelOverride: options?.model,
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Ollama stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Ollama stream failed: empty response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let lineBreak = buffer.indexOf("\n");
      while (lineBreak !== -1) {
        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);

        if (line) {
          const data = parseOllamaLine(line);
          if (data.error) {
            throw new Error(`Ollama error: ${data.error}`);
          }
          // Skip thinking-only chunks (Ollama 0.6+ thinking models):
          // during reasoning phase, message.thinking has content but message.content is empty.
          const content = data.message?.content;
          if (content) {
            yield content;
          }
        }

        lineBreak = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      const data = parseOllamaLine(trailing);
      if (data.error) {
        throw new Error(`Ollama error: ${data.error}`);
      }
      const content = data.message?.content;
      if (content) {
        yield content;
      }
    }
  }

  private async fetchChat(params: {
    messages: ChatMessage[];
    stream: boolean;
    operation: "request" | "stream";
    modelOverride?: string;
  }): Promise<Response> {
    const { messages, stream, operation, modelOverride } = params;
    const endpoint = `${this.baseUrl}/api/chat`;
    const resolvedModel = modelOverride ?? this.model;

    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        stream,
        keep_alive: this.keepAlive,
        options: {
          temperature: 0, // Low temperature for more deterministic JSON output
          ...this.ollamaOptions,
        },
      }),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= OLLAMA_FETCH_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );
      try {
        return await fetch(endpoint, {
          ...requestInit,
          signal: controller.signal,
        });
      } catch (error: unknown) {
        lastError = error;
        if (
          attempt === OLLAMA_FETCH_MAX_RETRIES ||
          !isRetryableFetchError(error)
        ) {
          break;
        }
        await sleep(OLLAMA_FETCH_RETRY_DELAY_MS);
      }
    }

    throw new Error(
      buildOllamaFetchFailureMessage({
        operation,
        endpoint,
        model: resolvedModel,
        error: lastError,
        retries: OLLAMA_FETCH_MAX_RETRIES,
        requestTimeoutMs: this.requestTimeoutMs,
      }),
    );
  }
}

interface OllamaRequestOptions {
  num_ctx?: number;
  num_predict?: number;
  num_thread?: number;
  temperature?: number;
}

const DEFAULT_OLLAMA_NUM_PREDICT = 16384; // Generous default to prevent empty responses

function parseOllamaLine(line: string): OllamaChatResponse {
  try {
    return JSON.parse(line) as OllamaChatResponse;
  } catch {
    throw new Error("Ollama stream returned invalid JSON line");
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

function buildOllamaFetchFailureMessage(params: {
  operation: "request" | "stream";
  endpoint: string;
  model: string;
  error: unknown;
  retries?: number;
  requestTimeoutMs?: number;
}): string {
  const {
    operation,
    endpoint,
    model,
    error,
    retries = 0,
    requestTimeoutMs,
  } = params;
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();

  const hints: string[] = [
    `operation=${operation}`,
    `model=${model}`,
    `endpoint=${endpoint}`,
    `retries=${retries}`,
  ];
  if (typeof requestTimeoutMs === "number") {
    hints.push(`timeoutMs=${requestTimeoutMs}`);
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("context canceled")
  ) {
    hints.push(
      'Hint: model runner timed out starting. Try a smaller model or pre-warm with `ollama run <model> "hi"`.',
    );
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("connect") ||
    lower.includes("fetch failed")
  ) {
    hints.push(
      "Hint: check Ollama server with `ollama ps` and `curl http://127.0.0.1:11434/api/tags`.",
    );
  }

  return `Ollama ${operation} failed: ${raw}. ${hints.join(" | ")}`;
}

function isRetryableFetchError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("context canceled")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildOllamaRequestOptions(): OllamaRequestOptions {
  return {
    num_ctx: parseOptionalPositiveInteger(process.env.OLLAMA_NUM_CTX),
    num_predict: parseOptionalPositiveInteger(
      process.env.OLLAMA_NUM_PREDICT,
      DEFAULT_OLLAMA_NUM_PREDICT,
    ),
    num_thread: parseOptionalPositiveInteger(process.env.OLLAMA_NUM_THREAD),
    temperature: parseOptionalPositiveInteger(
      process.env.OLLAMA_TEMPERATURE,
      0,
    ),
  };
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  fallback?: number,
): number | undefined {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}
