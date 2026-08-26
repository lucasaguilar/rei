import { describe, it, expect, vi, afterEach } from "vitest";
import { McpOAuthProvider, LOGIN_TIMEOUT_MS } from "./oauth-provider.js";

/**
 * The browser-login wait is the one place REI blocks on a human. Two properties matter:
 *   1. It gives up (5 min) instead of hanging forever — startup awaits connectMcp().
 *   2. On success it leaves NOTHING behind. An un-cleared 5-minute timer keeps Node's event loop
 *      alive, so a one-shot `rei plan "…"` would sit there for minutes after finishing its work.
 *
 * Note on style: every rejection assertion is attached BEFORE the rejection is triggered. Attaching
 * it after lets the promise reject with no handler for a tick, which Node reports as an unhandled
 * rejection — the test would pass and still poison the run.
 */
let provider: McpOAuthProvider | undefined;
afterEach(() => {
  provider?.stop();
  provider = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("waitForCode", () => {
  it("resolves with the callback's code and clears its timeout", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    provider = new McpOAuthProvider("test-server");
    await provider.start();

    const waiting = provider.waitForCode();
    const res = await fetch(`${provider.redirectUrl}?code=abc123`);
    expect(res.status).toBe(200);
    await expect(waiting).resolves.toBe("abc123");

    // Lo que importa: el timer de 5 minutos no queda vivo sosteniendo el event loop.
    expect(clearSpy).toHaveBeenCalled();
  });

  it("rejects when the user never logs in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    provider = new McpOAuthProvider("test-server");
    await provider.start();

    const assertion = expect(provider.waitForCode()).rejects.toThrow(
      /Timed out waiting for browser login/,
    );
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS + 1);
    await assertion;
  });

  it("rejects when the provider returns an error instead of a code", async () => {
    provider = new McpOAuthProvider("test-server");
    await provider.start();

    const assertion = expect(provider.waitForCode()).rejects.toThrow(/access_denied/);
    const res = await fetch(`${provider.redirectUrl}?error=access_denied`);
    expect(res.status).toBe(400);
    await assertion;
  });

  it("refuses to wait when the callback server was never started", async () => {
    provider = new McpOAuthProvider("test-server");
    await expect(provider.waitForCode()).rejects.toThrow(/callback server not started/);
  });

  it("stop() closes the callback server", async () => {
    provider = new McpOAuthProvider("test-server");
    await provider.start();
    const url = provider.redirectUrl;
    provider.stop();
    provider = undefined;
    await expect(fetch(url)).rejects.toThrow();
  });
});
