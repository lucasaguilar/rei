import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  WHATSAPP_WEBHOOK_PATH,
  isWhatsAppWebhookRequest,
  handleWhatsAppWebhook,
} from "./whatsapp-webhook.js";

/**
 * The webhook is the only route Meta can reach, and the only one whose auth is an HMAC signature
 * instead of a bearer token. These tests pin the contract the plan locks: a plain-text GET
 * handshake, a signature-checked POST that answers 200 immediately, dedupe by message id, and a
 * statuses branch that never reaches the agent.
 */

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The `X-Hub-Signature-256` header value Meta sends for a given raw body. */
function sign(body: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** A minimal `http.IncomingMessage` / `ServerResponse` pair for one request. */
function makeReq(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
) {
  const req = Object.assign(new PassThrough(), {
    method,
    url,
    headers,
  });
  req.end(body);
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    write(chunk: string) {
      this.body += chunk;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
    },
  };
  return { req, res };
}

/** One inbound text message in the real Meta payload shape. */
function messagePayload(overrides: {
  id?: string;
  from?: string;
  body?: string;
  type?: string;
} = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1993699757789718",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15556668060",
                phone_number_id: "1000000000000001",
              },
              contacts: [{ wa_id: overrides.from ?? "5491100001234" }],
              messages: [
                {
                  from: overrides.from ?? "5491100001234",
                  id: overrides.id ?? "wamid.A",
                  timestamp: "1790375830",
                  type: overrides.type ?? "text",
                  text: { body: overrides.body ?? "hola" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("isWhatsAppWebhookRequest", () => {
  it("exposes the path the router matches on", () => {
    expect(WHATSAPP_WEBHOOK_PATH).toBe("/webhooks/whatsapp");
  });

  it("matches the route regardless of the /v1 prefix, trailing slash or query", () => {
    expect(isWhatsAppWebhookRequest("/webhooks/whatsapp", "GET")).toBe(true);
    expect(isWhatsAppWebhookRequest("/v1/webhooks/whatsapp", "POST")).toBe(true);
    expect(isWhatsAppWebhookRequest("/webhooks/whatsapp/", "GET")).toBe(true);
    expect(isWhatsAppWebhookRequest("/webhooks/whatsapp?x=1", "POST")).toBe(true);
    expect(isWhatsAppWebhookRequest("/chat/completions", "POST")).toBe(false);
    expect(isWhatsAppWebhookRequest("/healthz", "GET")).toBe(false);
  });
});

describe("GET handshake", () => {
  it("echoes the challenge as plain text for a valid subscribe", async () => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", VERIFY_TOKEN);
    const { req, res } = makeReq(
      `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1589196134710.7825785997596`,
      "GET",
      "",
    );
    await handleWhatsAppWebhook(req as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/plain");
    expect(res.body).toBe("1589196134710.7825785997596");
  });

  it("rejects a wrong verify token with 403", async () => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", VERIFY_TOKEN);
    const { req, res } = makeReq(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x",
      "GET",
      "",
    );
    await handleWhatsAppWebhook(req as any, res as any);
    expect(res.statusCode).toBe(403);
  });

  it("rejects a non-subscribe mode with 403", async () => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", VERIFY_TOKEN);
    const { req, res } = makeReq(
      `/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
      "GET",
      "",
    );
    await handleWhatsAppWebhook(req as any, res as any);
    expect(res.statusCode).toBe(403);
  });
});

describe("POST signature", () => {
  it("rejects a missing signature with 401", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    const body = JSON.stringify(messagePayload());
    const { req, res } = makeReq("/webhooks/whatsapp", "POST", body, {});
    await handleWhatsAppWebhook(req as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it("rejects a bad signature with 401", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    const body = JSON.stringify(messagePayload());
    const { req, res } = makeReq(
      "/webhooks/whatsapp",
      "POST",
      body,
      { "x-hub-signature-256": sign(body, "a-different-secret") },
    );
    await handleWhatsAppWebhook(req as any, res as any);
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid signature with 200 and hands the message to the handler", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    const handler = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify(messagePayload({ id: "wamid.sig", body: "hola" }));
    const { req, res } = makeReq(
      "/webhooks/whatsapp",
      "POST",
      body,
      { "x-hub-signature-256": sign(body) },
    );
    await handleWhatsAppWebhook(req as any, res as any, { handleInbound: handler });
    expect(res.statusCode).toBe(200);
    await Promise.resolve(); // the handoff is async, after the 200
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg.from).toBe("5491100001234");
    expect(msg.id).toBe("wamid.sig");
    expect(msg.body).toBe("hola");
    expect(msg.type).toBe("text");
    expect(msg.phoneNumberId).toBe("1000000000000001");
  });
});

describe("dedupe", () => {
  it("ignores a retried delivery with the same message id", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    const handler = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify(messagePayload({ id: "wamid.dup" }));
    const sig = sign(body);

    const first = makeReq("/webhooks/whatsapp", "POST", body, {
      "x-hub-signature-256": sig,
    });
    await handleWhatsAppWebhook(first.req as any, first.res as any, {
      handleInbound: handler,
    });
    await Promise.resolve();

    const second = makeReq("/webhooks/whatsapp", "POST", body, {
      "x-hub-signature-256": sig,
    });
    await handleWhatsAppWebhook(second.req as any, second.res as any, {
      handleInbound: handler,
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("statuses", () => {
  it("routes status events to the status handler, never the agent", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    const handleInbound = vi.fn().mockResolvedValue(undefined);
    const onStatus = vi.fn();
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1993699757789718",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "1000000000000001" },
                statuses: [
                  {
                    id: "wamid.HBgN...",
                    status: "delivered",
                    recipient_id: "5491100001234",
                    timestamp: "1790346042",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const { req, res } = makeReq(
      "/webhooks/whatsapp",
      "POST",
      body,
      { "x-hub-signature-256": sign(body) },
    );
    await handleWhatsAppWebhook(req as any, res as any, {
      handleInbound,
      onStatus,
    });
    expect(res.statusCode).toBe(200);
    await Promise.resolve();
    expect(handleInbound).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls[0][0].status).toBe("delivered");
  });
});

describe("allowlist", () => {
  it("serves everyone when the allowlist is empty (open)", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "");
    const handler = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify(messagePayload({ id: "wamid.open", from: "5551234567" }));
    const { req, res } = makeReq(
      "/webhooks/whatsapp",
      "POST",
      body,
      { "x-hub-signature-256": sign(body) },
    );
    await handleWhatsAppWebhook(req as any, res as any, { handleInbound: handler });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("drops a sender not on a non-empty allowlist", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "5491100001234");
    const handler = vi.fn().mockResolvedValue(undefined);
    const body = JSON.stringify(messagePayload({ id: "wamid.blocked", from: "5559999999" }));
    const { req, res } = makeReq(
      "/webhooks/whatsapp",
      "POST",
      body,
      { "x-hub-signature-256": sign(body) },
    );
    await handleWhatsAppWebhook(req as any, res as any, { handleInbound: handler });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });
});
