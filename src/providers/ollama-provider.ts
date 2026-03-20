import type { ChatMessage } from "../chat/types.js";
import type { ModelProvider } from "./model-provider.js";

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
  };
  error?: string;
  done?: boolean;
}

export class OllamaProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(params?: { baseUrl?: string; model?: string }) {
    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"
    );
    this.model = params?.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
  }

  async complete(prompt: string): Promise<string> {
    return this.completeChat([{ role: "user", content: prompt }]);
  }

  async completeChat(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Ollama request failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    return data.message?.content ?? "";
  }

  async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(
        `Ollama stream failed (${response.status} ${response.statusText})${details ? `: ${details}` : ""}`
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
}

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
