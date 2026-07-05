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
// A timeout-abort means the request ran the FULL window and still didn't finish — retrying with
// the same window almost always aborts again (e.g. a vision model too slow for the page). The one
// case a retry rescues is cold-start: the first call aborted while the model was LOADING, and the
// second finds it warm. So an abort gets at most ONE retry, regardless of maxRetries — connection
// drops (fetch failed / ECONNRESET) still get the full maxRetries. Without this, a slow OCR page
// burned 4×timeout (e.g. 20 min) before failing, turning a scan into hours of dead time.
const ABORT_MAX_RETRIES = 1;

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
    // Our per-attempt timeout aborts the request → "This operation was aborted". The only abort
    // source here is that timeout (no external cancel signal is threaded in), so a fresh attempt
    // is safe — rescues a cold-start first call where model-load ate the first window.
    msg.includes("aborted") ||
    msg.includes("context canceled")
  );
}

/** True when the error is our per-attempt timeout firing the AbortController. */
export function isAbortError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return msg.includes("aborted");
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
  let abortRetries = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error: unknown) {
      lastError = error;
      if (attempt === maxRetries || !isRetryableFetchError(error)) break;
      // A timed-out request re-runs identically; cap abort retries so a slow backend
      // fails fast instead of burning maxRetries×timeout (only cold-start needs the 1 retry).
      if (isAbortError(error)) {
        if (abortRetries >= ABORT_MAX_RETRIES) break;
        abortRetries += 1;
      }
      await sleep(retryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
