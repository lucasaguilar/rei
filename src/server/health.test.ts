import { describe, it, expect } from "vitest";
import { HEALTH_PATH, isHealthProbe, normalizeRoutePath } from "./health.js";

/**
 * The probe exists because of one interaction: the Docker image opens the server to 0.0.0.0, which
 * makes REI_SERVER_TOKEN mandatory (server.ts refuses to start otherwise) — and a platform health
 * check cannot send that token. Pointed at an authenticated route it gets a 401, the service is
 * declared unhealthy, and the host restarts it forever.
 */
describe("normalizeRoutePath", () => {
  it("agrees with the router: query, trailing slash and the /v1 prefix all drop out", () => {
    expect(normalizeRoutePath("/healthz")).toBe(HEALTH_PATH);
    expect(normalizeRoutePath("/v1/healthz")).toBe(HEALTH_PATH);
    expect(normalizeRoutePath("/healthz/")).toBe(HEALTH_PATH);
    expect(normalizeRoutePath("/healthz?probe=render")).toBe(HEALTH_PATH);
    expect(normalizeRoutePath("/v1/chat/completions")).toBe("/chat/completions");
    expect(normalizeRoutePath(undefined)).toBe("/");
  });
});

describe("isHealthProbe", () => {
  it("recognises the bare GET a platform sends", () => {
    expect(isHealthProbe("/healthz", "GET")).toBe(true);
    expect(isHealthProbe("/v1/healthz", "GET")).toBe(true);
  });

  it("exempts NOTHING else — every other route stays behind the token", () => {
    expect(isHealthProbe("/models", "GET")).toBe(false);
    expect(isHealthProbe("/chat/completions", "POST")).toBe(false);
    expect(isHealthProbe("/v1/chat/completions", "POST")).toBe(false);
    expect(isHealthProbe("/", "GET")).toBe(false);
  });

  it("is a GET, so the probe path cannot be used to send anything", () => {
    expect(isHealthProbe("/healthz", "POST")).toBe(false);
    expect(isHealthProbe("/healthz", "DELETE")).toBe(false);
  });
});
