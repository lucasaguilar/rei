/**
 * @fileoverview The WhatsApp Cloud API webhook — the only route Meta can reach.
 *
 * Meta authenticates with an HMAC signature, not a bearer token, so this route bypasses the
 * `REI_SERVER_TOKEN` check (like `/healthz`) but is gated by its own signature. Two verbs:
 *
 *  - **GET** — the one-time verification handshake: echo `hub.challenge` as plain text when
 *    `hub.mode=subscribe` and `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`.
 *  - **POST** — an inbound event. Verify `X-Hub-Signature-256` (HMAC-SHA256 of the RAW body with
 *    `WHATSAPP_APP_SECRET`), answer 200 immediately (Meta retries slow deliveries), then process
 *    asynchronously: dedupe by message id, apply the allowlist, hand off to the channel.
 *
 * The channel (Step 3) is injected, so this module is testable in isolation and never imports the
 * agent. `statuses` events (delivered/read/failed) are routed to a status callback, never the agent.
 *
 * @module rei/server/whatsapp-webhook
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeRoutePath } from "./health.js";
import { waLog, waError, maskNumber, describeBody } from "./whatsapp-log.js";

/** The path the router matches on (after `normalizeRoutePath`). */
export const WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";

/** Whether this request is the WhatsApp webhook, regardless of /v1, trailing slash or query. */
export function isWhatsAppWebhookRequest(
  url: string | undefined,
  method: string | undefined,
): boolean {
  return normalizeRoutePath(url) === WHATSAPP_WEBHOOK_PATH;
}

/** One inbound text message, normalized from Meta's `entry[].changes[].value.messages[]`. */
export interface WhatsAppInbound {
  /** Sender phone number (E.164-ish, e.g. "5491100001234") — the session key. */
  from: string;
  /** Meta message id — the dedupe key. */
  id: string;
  /** The prompt, for `type: "text"`. */
  body: string;
  /** Meta message type (`text`, `image`, `audio`, …). */
  type: string;
  /** Epoch seconds, as a string — the 24h window check (Step 3). */
  timestamp: string;
  /** The business number this arrived at — a safety check that it is ours. */
  phoneNumberId: string;
}

/** A delivery-status event (`sent`/`delivered`/`read`/`failed`) — never reaches the agent. */
export interface WhatsAppStatus {
  id: string;
  status: string;
  recipientId: string;
  timestamp: string;
  /** On `failed`: Meta's reason (e.g. 131047, outside the 24h window) — given nowhere else. */
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

/** What the channel (Step 3) provides; injected so this module never imports the agent. */
export interface WhatsAppWebhookDeps {
  /** Runs one inbound message as a turn and sends the reply. */
  handleInbound: (msg: WhatsAppInbound) => Promise<void>;
  /** Observes delivery-status events (log-only for this stage). */
  onStatus?: (status: WhatsAppStatus) => void;
}

/**
 * Dispatches one WhatsApp webhook request. Resolves once the response is written; the async
 * processing (after the 200) is awaited so a caller — the test, or a future queue — can observe
 * completion. In production the 200 is already on the wire, so awaiting here costs Meta nothing.
 */
export async function handleWhatsAppWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps?: WhatsAppWebhookDeps,
): Promise<void> {
  if (req.method === "GET") {
    handleHandshake(req, res);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    return;
  }
  await handlePost(req, res, deps);
}

/** The one-time GET verification handshake. */
function handleHandshake(req: IncomingMessage, res: ServerResponse): void {
  const params = new URL(req.url ?? "", "http://localhost").searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN ?? "";

  if (mode === "subscribe" && expected && token === expected) {
    waLog("handshake ok");
    // Plain text, not JSON — the #1 documented failure is echoing the challenge as JSON.
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(challenge ?? "");
    return;
  }
  waError(
    !expected
      ? "handshake failed: WHATSAPP_VERIFY_TOKEN is not set"
      : mode !== "subscribe"
        ? `handshake failed: hub.mode is "${mode ?? ""}", expected "subscribe"`
        : "handshake failed: the verify token Meta sent does not match WHATSAPP_VERIFY_TOKEN",
  );
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Verification failed" } }));
}

/** The inbound POST: signature check, immediate 200, then async processing. */
async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  deps?: WhatsAppWebhookDeps,
): Promise<void> {
  const raw = await readRawBody(req);
  if (raw === null) {
    waError(`POST rejected: body too large (over ${MAX_BODY_BYTES} bytes)`);
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Payload too large" } }));
    return;
  }
  const secret = process.env.WHATSAPP_APP_SECRET ?? "";
  const sent = (req.headers["x-hub-signature-256"] as string | undefined) ?? "";

  // No secret configured means the webhook cannot be verified — refuse rather than run open.
  if (!secret || !verifySignature(raw, sent, secret)) {
    // The silent 401 this replaces is how a wrong secret looks from the phone: nothing at all.
    waError(
      !secret
        ? "POST rejected: WHATSAPP_APP_SECRET is not set"
        : !sent
          ? "POST rejected: no X-Hub-Signature-256 header (not a request from Meta?)"
          : "POST rejected: invalid signature — check WHATSAPP_APP_SECRET (Meta → App Settings → Basic → App Secret)",
    );
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid signature" } }));
    return;
  }

  // Answer first: Meta's ~20s timeout retries slow deliveries, so the 200 goes out before the
  // turn runs. The processing that follows is what the caller awaits.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ received: true }));

  await processPayload(raw, deps);
}

/** Constant-time HMAC-SHA256 check of the raw body against `X-Hub-Signature-256`. */
function verifySignature(raw: string, sent: string, secret: string): boolean {
  if (!sent) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(sent);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Meta's webhook payloads are a few KB. The body is read BEFORE the signature can be checked, on a
 * route anyone can reach, so without a bound a single huge POST holds that much memory.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Collects the request body as a string (the signature is over the RAW bytes); null when it
 *  exceeds MAX_BODY_BYTES — the rest is drained, not stored. */
function readRawBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Message ids already processed. Meta retries slow/failed deliveries, so the same id arrives more
 * than once; the Set makes the retry a no-op. Capped so a long-lived process cannot grow it
 * without bound — a full clear is safe (a re-delivered, already-answered message is harmless).
 */
const seenMessageIds = new Set<string>();
const SEEN_CAP = 1000;

/** Parses the payload and dispatches each message / status event. */
async function processPayload(raw: string, deps?: WhatsAppWebhookDeps): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    waError("POST ignored: body is not JSON");
    return;
  }
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id ?? "";
      // One Meta app can hold several numbers on one webhook (the test one and the real one): a
      // message to another number must not be answered from ours.
      const ours = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
      if (ours && phoneNumberId && phoneNumberId !== ours) {
        waLog(`✗ ignored event for phone_number_id ${phoneNumberId} (this server answers ${ours})`);
        continue;
      }

      // Statuses are delivery receipts, not messages — route them out, never to the agent.
      if (Array.isArray(value.statuses)) {
        for (const s of value.statuses) {
          deps?.onStatus?.({
            id: s.id,
            status: s.status,
            recipientId: s.recipient_id,
            timestamp: s.timestamp,
            errors: Array.isArray(s.errors) ? s.errors : undefined,
          });
        }
      }

      // Messages are arrays (Meta may batch) — iterate every element, never assume [0].
      if (!Array.isArray(value.messages)) continue;
      for (const m of value.messages) {
        const msg: WhatsAppInbound = {
          from: m.from,
          id: m.id,
          body: m.text?.body ?? "",
          type: m.type ?? "text",
          timestamp: m.timestamp ?? "",
          phoneNumberId,
        };
        if (!msg.id) continue;
        if (seenMessageIds.has(msg.id)) {
          waLog(`✗ ignored ${msg.id}: duplicate (Meta retry)`);
          continue;
        }
        waLog(`← msg ${msg.id} from ${maskNumber(msg.from)} ${msg.type}, ${describeBody(msg.body)}`);
        if (!isAllowed(msg.from)) {
          waLog(
            (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "").trim()
              ? `✗ ignored ${maskNumber(msg.from)}: not in WHATSAPP_ALLOWED_NUMBERS`
              : `✗ ignored ${maskNumber(msg.from)}: WHATSAPP_ALLOWED_NUMBERS is empty — set it to * to serve everyone`,
          );
          continue;
        }
        seenMessageIds.add(msg.id);
        if (seenMessageIds.size > SEEN_CAP) seenMessageIds.clear();
        await deps?.handleInbound?.(msg);
      }
    }
  }
}

/**
 * The sender allowlist. `WHATSAPP_ALLOWED_NUMBERS` is `*` (everyone — a public, corporate number)
 * or a comma-separated list. EMPTY SERVES NOBODY: a deploy that forgot the variable must not end up
 * open to the world, so serving everyone has to be written down.
 */
function isAllowed(from: string): boolean {
  const raw = (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "").trim();
  if (raw === "*") return true;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(from);
}
