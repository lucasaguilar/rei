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
 * MTPLX provider — thin wrapper around the OpenAI-compatible base.
 *
 * Customiza exclusivamente:
 *   - Prefijo de env vars (MTPLX_*)
 *   - URL base default (localhost:8000/v1)
 *   - API key default ("") — MTPLX no requiere auth por defecto
 *
 * Todo lo demás (streaming, tool calling, reasoning, penalties) es manejado por la clase base.
 */
export class MtplxProvider extends OpenAiCompatibleProvider {
  constructor(params?: { baseUrl?: string; apiKey?: string; model?: string }) {
    super();

    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.MTPLX_BASE_URL ?? DEFAULT_MTPLX_BASE_URL,
    );
    this.apiKey = params?.apiKey ?? process.env.MTPLX_API_KEY ?? "";
    this.model = params?.model ?? process.env.MTPLX_MODEL ?? "";
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.MTPLX_REQUEST_TIMEOUT_MS,
      DEFAULT_MTPLX_REQUEST_TIMEOUT_MS,
    );
    this.temperature = parseFloatEnv(
      process.env.MTPLX_TEMPERATURE,
      DEFAULT_MTPLX_TEMPERATURE,
      { min: 0, max: 2 },
    );
    this.repeatPenalty = process.env.MTPLX_REPEAT_PENALTY
      ? parseFloatEnv(process.env.MTPLX_REPEAT_PENALTY, 1.1, { min: 1, max: 2 })
      : undefined;
    this.frequencyPenalty = parseFloatEnv(
      process.env.MTPLX_FREQUENCY_PENALTY,
      DEFAULT_MTPLX_FREQUENCY_PENALTY,
      { min: 0, max: 2 },
    );
    this.presencePenalty = parseFloatEnv(
      process.env.MTPLX_PRESENCE_PENALTY,
      DEFAULT_MTPLX_PRESENCE_PENALTY,
      { min: 0, max: 2 },
    );
  }
}

// ── MTPLX-specific defaults (overridable via MTPLX_* env vars) ──────────

const DEFAULT_MTPLX_BASE_URL = "http://localhost:8000/v1";
const DEFAULT_MTPLX_REQUEST_TIMEOUT_MS = 600_000; // 10 minutes fallback for local inference
const DEFAULT_MTPLX_TEMPERATURE = 0.6;
const DEFAULT_MTPLX_FREQUENCY_PENALTY = 0.3;
const DEFAULT_MTPLX_PRESENCE_PENALTY = 0.3;

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
