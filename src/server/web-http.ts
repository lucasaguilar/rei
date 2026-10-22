/**
 * @fileoverview The web widget's HTTP transport — a PUBLIC route: the widget runs in a stranger's
 * browser, so it cannot hold a secret. It is gated by what a public client can carry, each layer
 * stopping something different:
 *
 *  - **Site key** (`REI_WEB_SITE_KEY`): public, like a site key — it names the site, it is not a
 *    password. Without one configured the route does not exist at all.
 *  - **Origin** (`REI_WEB_ALLOWED_ORIGINS`): a browser always sends it cross-origin and cannot be
 *    talked out of it, so another site cannot embed the widget. A script can forge it — this is
 *    hygiene, not authentication.
 *  - **Session id**: a plain token (it names a session file), checked before it reaches the disk.
 *  - **Rate limits** per session and per client address, in the channel (web-channel.ts). Behind a
 *    proxy (Render), `REI_TRUST_PROXY=true` makes the address the one the proxy saw.
 *
 * What a visitor can then do is fixed by the public-channel core: ask-only, read-only tools.
 *
 * Protocol: the one the widget already speaks. `POST /channels/web/message` with
 * `{ session_id, content, name? }` → `{ reply, status }`. The site key travels as
 * `Authorization: Bearer <key>` (the widget's existing header) or `X-Rei-Site-Key`.
 *
 * @module rei/server/web-http
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { normalizeRoutePath } from "./health.js";
import { webError, type WebChannel } from "./web-channel.js";

type Env = Record<string, string | undefined>;

export const WEB_CHANNEL_PATH = "/channels/web";
const MESSAGE_PATH = `${WEB_CHANNEL_PATH}/message`;

/** A chat message is a few KB at most; the body is read before anything else is checked. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 4000;
const MAX_NAME_CHARS = 60;
/** UUIDs and similar: no dots or slashes, since it becomes part of a file name. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether this request is for the web channel — never, unless the channel is configured. */
export function isWebChannelRequest(url: string | undefined, env: Env = process.env): boolean {
  if (!env.REI_WEB_SITE_KEY?.trim()) return false;
  const path = normalizeRoutePath(url);
  return path === WEB_CHANNEL_PATH || path.startsWith(`${WEB_CHANNEL_PATH}/`);
}

function allowedOrigins(env: Env): string[] {
  return (env.REI_WEB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sentSiteKey(req: IncomingMessage): string {
  const header = req.headers["x-rei-site-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * The address to rate-limit. Behind a trusted proxy, the LAST X-Forwarded-For entry: the proxy
 * appends the address it saw, while everything before it is whatever the client chose to send.
 */
function clientIp(req: IncomingMessage, env: Env): string {
  if (env.REI_TRUST_PROXY === "true") {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").pop()?.trim();
    if (last) return last;
  }
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const refuse = (res: ServerResponse, status: number, message: string) => send(res, status, { error: { message } });

/** The body as text, or null past MAX_BODY_BYTES (the rest is drained, not stored). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleWebChannelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  channel: WebChannel,
  env: Env = process.env,
): Promise<void> {
  // The server's own CORS headers name the owner's origin; this route answers the site's.
  res.removeHeader("Access-Control-Allow-Origin");
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin) {
    if (!allowedOrigins(env).includes(origin)) {
      refuse(res, 403, `Origin '${origin}' may not use this widget. List it in REI_WEB_ALLOWED_ORIGINS.`);
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Rei-Site-Key");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (normalizeRoutePath(req.url) !== MESSAGE_PATH || req.method !== "POST") {
    refuse(res, 404, `Not Found. Use POST ${MESSAGE_PATH}.`);
    return;
  }

  if (!sameSecret(sentSiteKey(req), env.REI_WEB_SITE_KEY?.trim() ?? "")) {
    refuse(res, 401, "Unknown site key.");
    return;
  }

  const raw = await readBody(req);
  if (raw === null) {
    refuse(res, 413, "Message too large.");
    return;
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    refuse(res, 400, "Body must be JSON: { session_id, content, name? }.");
    return;
  }

  const sessionId = body?.session_id;
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : undefined;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    refuse(res, 400, "session_id must be 1–64 letters, digits, '-' or '_'.");
    return;
  }
  if (!content || content.length > MAX_CONTENT_CHARS) {
    refuse(res, 400, `content must be 1–${MAX_CONTENT_CHARS} characters.`);
    return;
  }
  if (body?.name !== undefined && (typeof body.name !== "string" || name!.length > MAX_NAME_CHARS)) {
    refuse(res, 400, `name must be a string of at most ${MAX_NAME_CHARS} characters.`);
    return;
  }

  try {
    const result = await channel.handleMessage({
      sessionId,
      content,
      ...(name ? { name } : {}),
      ip: clientIp(req, env),
    });
    send(res, result.status, result.body);
  } catch (err) {
    webError(`✗ request failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) refuse(res, 500, "Internal error.");
  }
}
