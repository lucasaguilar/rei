/**
 * @fileoverview Keeping a web page from driving the local server.
 *
 * The server binds loopback by default and, with no `REI_SERVER_TOKEN`, checked nothing: it answered
 * `Access-Control-Allow-Origin: *` and served `/v1/chat/completions` to whoever asked. Loopback is
 * not a boundary against a browser — any page the user visits can POST to 127.0.0.1, and the
 * wildcard lets it read the response. That is an agent which runs commands in the user's repository,
 * reachable from a tab.
 *
 * Two checks, both keyed on headers a browser sets and cannot be talked out of:
 *
 *  - **Origin.** A cross-origin request always carries it. Real clients — curl, Cline, Continue, an
 *    extension's node process — send none, so they are unaffected; a page is rejected unless its
 *    origin is named in `REI_SERVER_ORIGIN`.
 *  - **Host.** While bound to loopback, a request whose Host is someone else's name means DNS
 *    rebinding: `evil.example` resolved to 127.0.0.1, so the browser believes it is same-origin and
 *    sends no Origin at all. Bound to a public interface the hostname is legitimately not loopback,
 *    a token is mandatory there, and auth is the gate — so the check applies only to loopback.
 *
 * Neither replaces the token. They close the case where there is no token because the server was
 * only ever meant to be reachable from this machine.
 *
 * @module rei/server/browser-guard
 */

/** A rejection to write back, or `null` when the request may proceed. */
export interface BrowserGuardRejection {
  status: number;
  message: string;
}

/** Parses `REI_SERVER_ORIGIN` — one origin or a comma-separated list. */
export function allowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Whether a `Host` header points at this machine. Covers the whole `127.0.0.0/8` range and the IPv6
 * loopback in its bracketed form, with or without a port — all of which reach the same listener.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1) // [::1]:3000 → [::1]
    : host.split(":")[0];
  if (name === "localhost" || name === "[::1]" || name === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** True when the server is listening on loopback only. */
function boundToLoopback(boundHost: string): boolean {
  return boundHost === "127.0.0.1" || boundHost === "localhost" || boundHost === "::1";
}

/**
 * Applies both checks to one request. `allowedOrigin` is `REI_SERVER_ORIGIN` verbatim; `*` waives
 * the origin check for anyone who insists on it.
 */
export function evaluateBrowserRequest(req: {
  origin: string | undefined;
  host: string | undefined;
  boundHost: string;
  allowedOrigin: string;
}): BrowserGuardRejection | null {
  if (boundToLoopback(req.boundHost) && !isLoopbackHost(req.host)) {
    return {
      status: 403,
      message:
        `Forbidden: unexpected Host header '${req.host ?? ""}'. This server listens on loopback, ` +
        `so a request arriving for another name is not coming from this machine as it claims.`,
    };
  }

  if (req.origin) {
    const allowed = allowedOrigins(req.allowedOrigin);
    if (!allowed.includes("*") && !allowed.includes(req.origin)) {
      return {
        status: 403,
        message:
          `Forbidden: origin '${req.origin}' is not allowed. A browser page may not drive this ` +
          `server — it runs commands and edits files. List the origin in REI_SERVER_ORIGIN if the ` +
          `request is really yours.`,
      };
    }
  }

  return null;
}
