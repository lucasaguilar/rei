import type { ChatMessage } from "../chat/types.js";
import type {
  ModelProvider,
  CompletionOptions,
  ToolDefinition,
  ChatCompletionWithTools,
  ToolStreamDelta,
} from "./model-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";

/**
 * LM Studio provider — thin wrapper around the OpenAI-compatible base.
 *
 * Customises only:
 *   - the env-var prefix (LLM_STUDIO_*, kept as-is: it was never part of the `llmstudio` typo)
 *   - the default base URL (localhost:1234/v1)
 *   - the default API key ("lm-studio")
 *
 * Everything else (streaming, tool calling, reasoning, penalties) is handled by the base class.
 */
export class LmStudioProvider extends OpenAiCompatibleProvider {
  constructor(params?: { baseUrl?: string; apiKey?: string; model?: string }) {
    super();

    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.LLM_STUDIO_BASE_URL ?? DEFAULT_LLM_STUDIO_BASE_URL,
    );
    this.apiKey = params?.apiKey ?? process.env.LLM_STUDIO_API_KEY ?? "lm-studio";
    this.model = params?.model ?? process.env.LLM_STUDIO_MODEL ?? "";
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.LLM_STUDIO_REQUEST_TIMEOUT_MS,
      DEFAULT_LLM_STUDIO_REQUEST_TIMEOUT_MS,
    );
    this.temperature = parseFloatEnv(
      process.env.LLM_STUDIO_TEMPERATURE,
      DEFAULT_LLM_STUDIO_TEMPERATURE,
      { min: 0, max: 2 },
    );
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
}

// ── LM Studio-specific defaults (overridable via LLM_STUDIO_* env vars) ───

const DEFAULT_LLM_STUDIO_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_LLM_STUDIO_REQUEST_TIMEOUT_MS = 600_000; // 10 minutes fallback for local inference
const DEFAULT_LLM_STUDIO_TEMPERATURE = 0.6;
const DEFAULT_LLM_STUDIO_FREQUENCY_PENALTY = 0.3;
const DEFAULT_LLM_STUDIO_PRESENCE_PENALTY = 0.3;

// ── Shared helpers (extracted so subclasses don't duplicate) ─────────────

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
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
