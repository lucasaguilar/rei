/**
 * The unauthenticated liveness probe.
 *
 * Every other route sits behind `REI_SERVER_TOKEN` when one is set — and on a public host one MUST
 * be set, because the server refuses to start otherwise (see server.ts). A platform health check
 * cannot carry that header: Render, Fly and friends issue a bare GET. Pointed at `/models` it gets
 * a 401, the service is declared unhealthy and restarted forever.
 *
 * So the probe answers before the auth check, and answers as little as possible: no model names,
 * no workspace path, no version — a literal `{"status":"ok"}`. The fact that a REI server is
 * listening is already implied by the port being open.
 */
export const HEALTH_PATH = "/healthz";

export const HEALTH_BODY = JSON.stringify({ status: "ok" });

/**
 * Normalizes a request URL the way the router does: query string dropped, trailing slashes
 * removed, an optional `/v1` prefix stripped (OpenAI-compatible clients disagree about it).
 */
export function normalizeRoutePath(url: string | undefined): string {
  return (
    (url || "").split("?")[0].replace(/\/+$/, "").replace(/^\/v1/, "") || "/"
  );
}

/** Whether this request is the liveness probe, which bypasses authentication. */
export function isHealthProbe(url: string | undefined, method: string | undefined): boolean {
  return method === "GET" && normalizeRoutePath(url) === HEALTH_PATH;
}
