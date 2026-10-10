import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { handleWhatsAppWebhook } from "./whatsapp-webhook.js";
import { createWhatsAppChannel } from "./whatsapp-channel.js";
import type { WhatsAppInbound } from "./whatsapp-webhook.js";

/**
 * A corporate number open to the public: many strangers, at once. What that needs beyond the MVP —
 * an explicit choice to serve everyone, a bound on parallel turns and on how fast one sender can
 * spend tokens, and refusing what is not for this number or not a webhook at all.
 */

const SECRET = "hardening-secret";
const sign = (b: string) => `sha256=${createHmac("sha256", SECRET).update(b).digest("hex")}`;

let lines: string[];
beforeEach(() => {
  lines = [];
  const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const logged = () => lines.join("\n");

function post(body: string, signature = sign(body)) {
  const req = Object.assign(new PassThrough(), {
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: { "x-hub-signature-256": signature },
  });
  req.end(body);
  const res = {
    statusCode: 0,
    writeHead(s: number) {
      this.statusCode = s;
    },
    end() {},
  };
  return { req: req as never, res };
}

let seq = 0;
function payload(from: string, phoneNumberId = "1000000000000001", extra: object = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  from,
                  id: `wamid.H${++seq}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hola" },
                },
              ],
              ...extra,
            },
          },
        ],
      },
    ],
  });
}

async function deliver(body: string) {
  const handled: WhatsAppInbound[] = [];
  const { req, res } = post(body);
  await handleWhatsAppWebhook(req, res as never, { handleInbound: async (m) => void handled.push(m) });
  return { handled, status: res.statusCode };
}

describe("allowlist: serving everyone is a choice, not a default", () => {
  it("empty serves nobody — a deploy missing the variable is not open to the world", async () => {
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "");
    expect((await deliver(payload("5491100000001"))).handled).toHaveLength(0);
    expect(logged()).toMatch(/WHATSAPP_ALLOWED_NUMBERS is empty.*\*/);
  });

  it("* serves everyone — the corporate, public number", async () => {
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "*");
    expect((await deliver(payload("5491100000002"))).handled).toHaveLength(1);
  });

  it("a list serves only the listed numbers", async () => {
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "5491100000003, 5491100000004");
    expect((await deliver(payload("5491100000004"))).handled).toHaveLength(1);
    expect((await deliver(payload("5491100000005"))).handled).toHaveLength(0);
  });
});

describe("messages for another number", () => {
  it("are ignored when WHATSAPP_PHONE_NUMBER_ID names ours", async () => {
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "*");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1000000000000001");
    // A Meta app can hold several numbers (a test one and the real one) on one webhook: a message
    // to the other must not be answered from ours.
    expect((await deliver(payload("5491100000006", "999000111222333"))).handled).toHaveLength(0);
    expect(logged()).toMatch(/ignored.*phone_number_id 999000111222333/);
    expect((await deliver(payload("5491100000006", "1000000000000001"))).handled).toHaveLength(1);
  });
});

describe("request body size", () => {
  it("refuses an oversized body with 413, before spending an HMAC on it", async () => {
    const huge = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) });
    const { req, res } = post(huge, "sha256=00");
    await handleWhatsAppWebhook(req, res as never, { handleInbound: async () => {} });
    expect(res.statusCode).toBe(413);
    expect(logged()).toMatch(/too large/);
  });
});

describe("failed deliveries", () => {
  it("log Meta's reason, which is the only place it is given", async () => {
    vi.stubEnv("WHATSAPP_ALLOWED_NUMBERS", "*");
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: "wamid.F",
                    status: "failed",
                    recipient_id: "5491100000007",
                    timestamp: "1",
                    errors: [{ code: 131047, title: "Re-engagement message" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const { req, res } = post(body);
    const channel = createWhatsAppChannel({} as never, "/tmp/rei-wa-hardening");
    await handleWhatsAppWebhook(req, res as never, channel);
    expect(logged()).toMatch(/failed for …0007.*131047.*Re-engagement message/);
  });
});

describe("channel limits", () => {
  const msg = (from: string, id: string): WhatsAppInbound => ({
    from,
    id,
    body: "hola",
    type: "text",
    timestamp: String(Math.floor(Date.now() / 1000)),
    phoneNumberId: "1000000000000001",
  });
  const graphOk = () => {
    // Typed like fetch, so `mock.calls[n][1]` (the request init) is visible to the type checker.
    const fn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ messages: [{ id: "out" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  };
  beforeEach(() => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1000000000000001");
  });

  it("caps how many turns run at once across customers (REI_WHATSAPP_MAX_CONCURRENT)", async () => {
    vi.stubEnv("REI_WHATSAPP_MAX_CONCURRENT", "2");
    graphOk();
    let running = 0;
    let peak = 0;
    const agent = {
      streamTurn: async function* () {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        yield "\x11ok";
      },
    } as never;
    const channel = createWhatsAppChannel(agent, "/tmp/rei-wa-concurrency");
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => channel.handleInbound(msg(`54911000001${n}0`, `wamid.cc${n}`))),
    );
    expect(peak).toBe(2);
  });

  it("limits how fast one number can spend turns, and tells them once", async () => {
    vi.stubEnv("REI_WHATSAPP_RATE_PER_MIN", "3");
    const fetchFn = graphOk();
    const streamTurn = vi.fn(async function* () {
      yield "\x11ok";
    });
    const channel = createWhatsAppChannel({ streamTurn } as never, "/tmp/rei-wa-rate");
    for (let i = 0; i < 6; i++) await channel.handleInbound(msg("5491100000099", `wamid.r${i}`));

    expect(streamTurn).toHaveBeenCalledTimes(3);
    const notices = fetchFn.mock.calls.filter((c) => /too fast/i.test(String(c[1]?.body)));
    expect(notices).toHaveLength(1);
    expect(logged()).toMatch(/ignored wamid\.r3 from …0099: rate limit \(3\/min\)/);
  });
});
