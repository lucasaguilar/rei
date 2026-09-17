import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import {
  forwardsTemplateKwargsFromEnv,
  normalizeBaseUrl,
  parseFloatEnv,
  parseRequestTimeoutMs,
} from "./provider-env.js";

/**
 * A generic OpenAI-compatible endpoint — vLLM, SGLang, llama.cpp's server, LiteLLM, a gateway, or
 * whatever ships next.
 *
 * Every one of those speaks the same wire protocol and differs only in what it does with the extras,
 * so the alternative to this provider is a new 40-line file per backend. Capabilities are DECLARED
 * here through env, never probed: a single request carrying `chat_template_kwargs` to a backend that
 * does not expect it returned a fatal exception and took the server down with it, so REI does not
 * find out by trying.
 *
 *   OPENAI_COMPAT_BASE_URL         required — e.g. http://localhost:8000/v1
 *   OPENAI_COMPAT_API_KEY          when the endpoint wants one
 *   OPENAI_COMPAT_MODEL            default model id
 *   OPENAI_COMPAT_TEMPLATE_KWARGS  "true" if it forwards chat_template_kwargs (default: false)
 */
export class OpenAiCompatProvider extends OpenAiCompatibleProvider {
  constructor(params?: { baseUrl?: string; apiKey?: string; model?: string }) {
    super();

    this.baseUrl = normalizeBaseUrl(
      params?.baseUrl ?? process.env.OPENAI_COMPAT_BASE_URL ?? DEFAULT_BASE_URL,
    );
    this.apiKey = params?.apiKey ?? process.env.OPENAI_COMPAT_API_KEY ?? "";
    // Default OFF: an unknown endpoint is assumed not to forward them, because the failure mode of
    // guessing wrong is the backend dying rather than the field being ignored.
    this.forwardsTemplateKwargs = forwardsTemplateKwargsFromEnv("OPENAI_COMPAT", false);
    this.model = params?.model ?? process.env.OPENAI_COMPAT_MODEL ?? "";
    this.requestTimeoutMs = parseRequestTimeoutMs(
      process.env.OPENAI_COMPAT_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.temperature = parseFloatEnv(process.env.OPENAI_COMPAT_TEMPERATURE, DEFAULT_TEMPERATURE, {
      min: 0,
      max: 2,
    });
    this.frequencyPenalty = parseFloatEnv(process.env.OPENAI_COMPAT_FREQUENCY_PENALTY, 0, {
      min: 0,
      max: 2,
    });
    this.presencePenalty = parseFloatEnv(process.env.OPENAI_COMPAT_PRESENCE_PENALTY, 0, {
      min: 0,
      max: 2,
    });
  }
}

const DEFAULT_BASE_URL = "http://localhost:8000/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_TEMPERATURE = 0.7;
