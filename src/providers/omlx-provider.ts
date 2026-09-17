import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import {
  forwardsTemplateKwargsFromEnv,
  normalizeBaseUrl,
  parseFloatEnv,
  parseRequestTimeoutMs,
} from "./provider-env.js";

/**
 * oMLX provider — thin wrapper over the OpenAI-compatible base.
 *
 * It exists as its own provider rather than being served by `llmstudio` with a different base URL,
 * because the two endpoints do NOT behave the same and the difference is not cosmetic: oMLX
 * forwards `chat_template_kwargs` to the chat template (verified: `enable_thinking:false` → zero
 * reasoning), while the same field sent to LM Studio returned a fatal backend exception and left it
 * unreachable. A provider whose name says "LM Studio" while pointing at oMLX cannot carry that.
 *
 * Customises only the env prefix (OMLX_*), the defaults, and that capability. Streaming, tool
 * calling, reasoning and penalties all come from the base.
 */
export class OmlxProvider extends OpenAiCompatibleProvider {
  constructor(params?: { baseUrl?: string; apiKey?: string; model?: string }) {
    super();

    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.OMLX_BASE_URL ?? DEFAULT_OMLX_BASE_URL,
    );
    // oMLX rejects an unauthenticated request with 401 even on localhost, so the key is not optional
    // the way it is for other local servers.
    this.apiKey = params?.apiKey ?? process.env.OMLX_API_KEY ?? "";
    this.forwardsTemplateKwargs = forwardsTemplateKwargsFromEnv("OMLX", true);
    this.model = params?.model ?? process.env.OMLX_MODEL ?? "";
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.OMLX_REQUEST_TIMEOUT_MS,
      DEFAULT_OMLX_REQUEST_TIMEOUT_MS,
    );
    this.temperature = parseFloatEnv(process.env.OMLX_TEMPERATURE, DEFAULT_OMLX_TEMPERATURE, {
      min: 0,
      max: 2,
    });
    this.frequencyPenalty = parseFloatEnv(process.env.OMLX_FREQUENCY_PENALTY, 0, {
      min: 0,
      max: 2,
    });
    this.presencePenalty = parseFloatEnv(process.env.OMLX_PRESENCE_PENALTY, 0, { min: 0, max: 2 });
  }
}

// ── oMLX defaults (overridable via OMLX_* env vars) ──────────────────────

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
/** Local inference: a cold prefill of a long prompt is measured in minutes, not seconds. */
const DEFAULT_OMLX_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_OMLX_TEMPERATURE = 0.7;
