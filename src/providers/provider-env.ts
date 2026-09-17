/**
 * Shared env parsing for the OpenAI-compatible providers.
 *
 * These lived as private copies inside mtplx-provider under a comment saying they were "extracted so
 * subclasses don't duplicate" — which they could not, being private to one subclass. With three more
 * providers on the same base (omlx, the generic OpenAI-compatible one), they move here so every
 * backend reads its environment the same way.
 */

/** Trailing slashes break `${baseUrl}/chat/completions`. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** A timeout under a second is a typo, not a choice — local inference takes minutes. */
export function parseRequestTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) return fallback;
  return Math.floor(parsed);
}

/** A sampling knob, bounded: out of range is a mistake and falls back rather than reaching the API. */
export function parseFloatEnv(
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

/**
 * Whether this backend forwards `chat_template_kwargs` to the chat template — the only door to
 * settings a Qwen-style template owns (thinking on/off, reasoning level).
 *
 * DECLARED per backend, never detected. Probing it is not safe: a single request carrying
 * `chat_template_kwargs` to LM Studio returned a fatal backend exception and left the server
 * unreachable. So each provider states what its endpoint does, and `<PREFIX>_TEMPLATE_KWARGS`
 * overrides it when the same provider class is pointed at a different server.
 */
export function forwardsTemplateKwargsFromEnv(prefix: string, defaultOn: boolean): boolean {
  const raw = process.env[`${prefix}_TEMPLATE_KWARGS`]?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return defaultOn;
}
