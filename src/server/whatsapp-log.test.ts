import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { maskNumber, describeBody } from "./whatsapp-log.js";
import { handleWhatsAppWebhook } from "./whatsapp-webhook.js";
import { createWhatsAppChannel } from "./whatsapp-channel.js";
import type { WhatsAppInbound } from "./whatsapp-webhook.js";

/**
 * What an operator sees when someone writes to the number. Before this, a misconfigured
 * WHATSAPP_APP_SECRET rejected every message from Meta with a silent 401: you wrote from your
 * phone, nothing happened, and the log was empty.
 */

const SECRET = "log-test-secret";
const sign = (b: string) => `sha256=${createHmac("sha256", SECRET).update(b).digest("hex")}`;

let lines: string[];
beforeEach(() => {
  lines = [];
  const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const logged = () => lines.join("\n");

function request(method: string, url: string, body = "", headers: Record<string, string> = {}) {
  const req = Object.assign(new PassThrough(), { method, url, headers });
  req.end(body);
  const res = {
    statusCode: 0,
    writeHead(s: number) {
      this.statusCode = s;
    },
    end() {},
  };
  return { req: req as never, res: res as never };
}

function payload(id: string, from: string, body = "hola") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1000000000000001" },
              messages: [
                { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe("maskNumber / describeBody", () => {
  it("keeps only the last 4 digits of a phone number", () => {
    expect(maskNumber("5491100001234")).toBe("…1234");
  });

  it("logs a message's length, and its text only when REI_WHATSAPP_LOG_BODY=true", () => {
    expect(describeBody("hola que tal")).toBe("12 chars");
    vi.stubEnv("REI_WHATSAPP_LOG_BODY", "true");
    expect(describeBody("hola que tal")).toBe('12 chars: "hola que tal"');
    expect(describeBody("x".repeat(200))).toMatch(/^200 chars: "x{80}…"$/);
  });
});

describe("webhook log", () => {
  it("says why a POST was rejected — and names the setting to check", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
    const body = payload("wamid.A", "5491100001234");
    const { req, res } = request("POST", "/webhooks/whatsapp", body, {
      "x-hub-signature-256": "sha256=00",
    });
    await handleWhatsAppWebhook(req, res, { handleInbound: async () => {} });
    expect(logged()).toMatch(/rejected.*invalid signature.*WHATSAPP_APP_SECRET/i);
  });

  it("says when no secret is configured at all", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    const { req, res } = request("POST", "/webhooks/whatsapp", "{}", { "x-hub-signature-256": "sha256=00" });
    await handleWhatsAppWebhook(req, res, { handleInbound: async () => {} });
    expect(logged()).toMatch(/WHATSAPP_APP_SECRET is not set/);
  });

  it("logs the handshake, ok or not", async () => {
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "vt");
    const ok = request("GET", "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=1");
    await handleWhatsAppWebhook(ok.req, ok.res);
    const bad = request("GET", "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1");
    await handleWhatsAppWebhook(bad.req, bad.res);
    expect(logged()).toMatch(/handshake ok/);
    expect(logged()).toMatch(/handshake failed.*verify token/i);
  });

  it("logs each incoming message with a masked number, and why one is ignored", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "5491100001234");
    const send = async (id: string, from: string) => {
      const body = payload(id, from);
      const { req, res } = request("POST", "/webhooks/whatsapp", body, { "x-hub-signature-256": sign(body) });
      await handleWhatsAppWebhook(req, res, { handleInbound: async () => {} });
    };
    await send("wamid.LOG1", "5491100001234");
    await send("wamid.LOG1", "5491100001234"); // Meta retry
    await send("wamid.LOG2", "5491100000001"); // not allowlisted

    const out = logged();
    expect(out).toMatch(/← msg wamid\.LOG1.*…1234.*text, 4 chars/);
    expect(out).toMatch(/ignored wamid\.LOG1: duplicate/);
    expect(out).toMatch(/ignored …0001: not in WHATSAPP_ALLOWED_NUMBERS/);
    expect(out).not.toContain("5491100001234"); // full numbers never reach the log
  });
});

describe("channel log", () => {
  const msg = (over: Partial<WhatsAppInbound> = {}): WhatsAppInbound => ({
    from: "5491100001234",
    id: "wamid.C",
    body: "hola",
    type: "text",
    timestamp: String(Math.floor(Date.now() / 1000)),
    phoneNumberId: "1000000000000001",
    ...over,
  });
  const graphOk = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 })),
    );

  beforeEach(() => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1000000000000001");
  });

  it("logs the turn from start to the reply that went out", async () => {
    graphOk();
    const agent = {
      streamTurn: async function* () {
        yield "\x11Hola!";
      },
    } as never;
    await createWhatsAppChannel(agent, "/tmp").handleInbound(msg());
    const out = logged();
    expect(out).toMatch(/turn for …1234 started/);
    expect(out).toMatch(/turn for …1234 done in [\d.]+s → reply 5 chars/);
    expect(out).toMatch(/→ sent wamid\.OUT to …1234/);
  });

  it("logs a failed turn, and tells the sender instead of leaving them waiting", async () => {
    graphOk();
    const agent = {
      // eslint-disable-next-line require-yield
      streamTurn: async function* () {
        throw new Error("provider exploded");
      },
    } as never;
    await expect(createWhatsAppChannel(agent, "/tmp").handleInbound(msg())).resolves.toBeUndefined();
    expect(logged()).toMatch(/turn for …1234 failed: provider exploded/);
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]?.body));
    expect(sent.some((b) => /went wrong/i.test(b))).toBe(true);
  });

  it("logs why a message never reached the agent", async () => {
    graphOk();
    const agent = { streamTurn: vi.fn() } as never;
    const ch = createWhatsAppChannel(agent, "/tmp");
    await ch.handleInbound(msg({ id: "wamid.I", type: "image", body: "" }));
    await ch.handleInbound(msg({ id: "wamid.S", body: "/mode agent" }));
    const out = logged();
    expect(out).toMatch(/ignored wamid\.I: image message/);
    expect(out).toMatch(/ignored wamid\.S: slash command/);
  });
});
