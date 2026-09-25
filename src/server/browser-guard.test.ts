import { describe, it, expect } from "vitest";
import { evaluateBrowserRequest, isLoopbackHost, allowedOrigins } from "./browser-guard.js";

/**
 * The attack this closes needs no token, no port scan and no network access: the server binds
 * loopback and, with no token set, answered `Access-Control-Allow-Origin: *` to anyone. Any page the
 * user happens to visit could POST /v1/chat/completions, drive an agent that runs commands in their
 * repository, and READ the reply — the wildcard grants exactly that.
 *
 * The fix keys on a fact browsers cannot lie about: a cross-origin request carries `Origin`. Real
 * clients (curl, Cline, Continue, an IDE extension's node process) send none, so they are untouched.
 * A `Host` that is not loopback while we are bound to loopback is the DNS-rebinding shape.
 */
const LOOPBACK = "127.0.0.1";

describe("isLoopbackHost", () => {
  it("accepts the loopback names and forms, with or without a port", () => {
    for (const h of ["127.0.0.1", "127.0.0.1:3000", "localhost", "localhost:3000",
                     "[::1]", "[::1]:3000", "127.3.2.1"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it("rejects anything that resolved somewhere else", () => {
    for (const h of ["evil.com", "evil.com:3000", "rei.local", "192.168.1.10:3000", "", undefined]) {
      expect(isLoopbackHost(h), String(h)).toBe(false);
    }
  });
});

describe("allowedOrigins", () => {
  it("splits a comma-separated list and ignores blanks", () => {
    expect(allowedOrigins("http://localhost:5173, https://app.example ")).toEqual([
      "http://localhost:5173",
      "https://app.example",
    ]);
    expect(allowedOrigins("")).toEqual([]);
    expect(allowedOrigins(undefined)).toEqual([]);
  });
});

describe("evaluateBrowserRequest", () => {
  const base = { host: LOOPBACK, boundHost: LOOPBACK, allowedOrigin: "" };

  it("lets a normal client through — no Origin header at all", () => {
    expect(evaluateBrowserRequest({ ...base, origin: undefined })).toBeNull();
  });

  it("REJECTS a page that tries to drive the server", () => {
    const r = evaluateBrowserRequest({ ...base, origin: "https://evil.example" });
    expect(r?.status).toBe(403);
    expect(r?.message).toMatch(/origin/i);
    expect(r?.message).toContain("REI_SERVER_ORIGIN"); // names the way to allow it
  });

  it("lets a declared origin through, so a real browser client still works", () => {
    const allowedOrigin = "http://localhost:5173";
    expect(evaluateBrowserRequest({ ...base, allowedOrigin, origin: allowedOrigin })).toBeNull();
    expect(evaluateBrowserRequest({ ...base, allowedOrigin, origin: "http://localhost:5174" })?.status).toBe(403);
  });

  it("refuses a page by DEFAULT — no token, nothing declared, which is the exposed case", () => {
    // The wildcard the server answers in `Access-Control-Allow-Origin` must not reach this decision:
    // "no token" is the configuration that needs the check, not the one that waives it.
    expect(evaluateBrowserRequest({ ...base, allowedOrigin: "", origin: "https://evil.example" })?.status).toBe(403);
  });

  it("honours a wildcard, for someone who insists", () => {
    expect(evaluateBrowserRequest({ ...base, allowedOrigin: "*", origin: "https://evil.example" })).toBeNull();
  });

  it("REJECTS a non-loopback Host while bound to loopback — DNS rebinding", () => {
    const r = evaluateBrowserRequest({ ...base, host: "evil.example", origin: undefined });
    expect(r?.status).toBe(403);
    expect(r?.message).toMatch(/host/i);
  });

  it("leaves Host alone when the operator bound a public interface on purpose", () => {
    // There the hostname IS someone else's, a token is mandatory, and auth is the gate.
    expect(evaluateBrowserRequest({
      host: "rei.example.com", boundHost: "0.0.0.0", allowedOrigin: "", origin: undefined,
    })).toBeNull();
  });
});
