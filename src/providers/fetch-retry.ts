/**
 * Shared fetch-with-retry for HTTP LLM backends (LM Studio / OpenAI-compatible, the
 * vision sidecar, etc.). Local model servers occasionally drop a connection mid-session
 * (idle-evict, OOM/restart, socket reset) and surface it as a bare "fetch failed". A
 * single transient drop should NOT nuke an entire agent turn, so we retry idempotent
 * GET/POST completion requests a small number of times with a short backoff.
 *
 * The Ollama provider has its own equivalent loop; this mirrors that behavior for every
 * other backend so retry handling is consistent across providers.
 */

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 900;

export interface FetchRetryOptions {
  /** Per-attempt timeout in ms (aborts the request). */
  timeoutMs: number;
  /** Extra attempts after the first (default 1 → up to 2 total). */
  maxRetries?: number;
  /** Backoff between attempts in ms (default 900). */
  retryDelayMs?: number;
}

/** Transient/connection-level errors worth retrying (not 4xx/5xx, which are returned as Response). */
export function isRetryableFetchError(error: unknown): boolean {
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

/**
 * Performs `fetch` with a per-attempt abort timeout and retry on transient connection
 * errors. Returns the Response as soon as headers arrive (the body — including streamed
 * bodies — is not covered by the timeout, matching the providers' prior behavior). HTTP
 * error statuses are returned, not retried; callers inspect `response.ok`.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions,
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error: unknown) {
      lastError = error;
      if (attempt === maxRetries || !isRetryableFetchError(error)) break;
      await sleep(retryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
