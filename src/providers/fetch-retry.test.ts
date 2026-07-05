import { describe, it, expect, vi, afterEach } from "vitest";
import { isRetryableFetchError, fetchWithRetry } from "./fetch-retry.js";

describe("isRetryableFetchError", () => {
  it("flags transient connection errors", () => {
    expect(isRetryableFetchError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableFetchError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableFetchError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableFetchError(new Error("request timed out"))).toBe(true);
    // AbortController timeout surfaces this exact message — must retry (cold-start rescue).
    expect(isRetryableFetchError(new Error("This operation was aborted"))).toBe(true);
  });

  it("does not flag non-transient errors", () => {
    expect(isRetryableFetchError(new Error("invalid argument"))).toBe(false);
    expect(isRetryableFetchError(new Error("400 Bad Request"))).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("retries once on a transient error then succeeds", async () => {
    const okResponse = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(okResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("http://x/y", { method: "POST" }, {
      timeoutMs: 1000,
      retryDelayMs: 1,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("nope, bad input"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("http://x/y", {}, { timeoutMs: 1000, retryDelayMs: 1 }),
    ).rejects.toThrow(/bad input/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries and throws the last error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("http://x/y", {}, {
        timeoutMs: 1000,
        maxRetries: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("retries an abort at most once even when maxRetries is higher (slow backend fails fast)", async () => {
    // A timed-out request re-runs identically; only cold-start benefits from ONE retry. Without the
    // cap this would attempt 4× (1 + maxRetries), each burning a full timeout.
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("This operation was aborted"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("http://x/y", {}, {
        timeoutMs: 1000,
        maxRetries: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/aborted/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 abort retry, not 4
  });

  it("still uses full maxRetries for connection drops (not abort)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("http://x/y", {}, {
        timeoutMs: 1000,
        maxRetries: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 3 retries — abort cap must not shrink this
  });

  it("returns HTTP error responses without retrying (caller checks .ok)", async () => {
    const errResponse = new Response("bad", { status: 500 });
    const fetchMock = vi.fn().mockResolvedValue(errResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("http://x/y", {}, { timeoutMs: 1000 });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
