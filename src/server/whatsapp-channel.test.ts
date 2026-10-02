import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWhatsAppChannel } from "./whatsapp-channel.js";
import type { WhatsAppInbound, WhatsAppStatus } from "./whatsapp-webhook.js";
import type { ChatSession } from "../chat/types.js";

/**
 * The WhatsApp channel is the bridge between the webhook (inbound) and the agent (turn) and the
 * Graph API (outbound). These tests pin the contract: per-number sessions, serialization, mode
 * forced to ask, slash-command blocking, 24h window, and 4096-char chunking on send.
 */

const ACCESS_TOKEN = "test-access-token";
const PHONE_NUMBER_ID = "1000000000000001";

/** A minimal agent mock that yields a fixed response. */
function mockAgent(response: string) {
  return {
    streamTurn: vi.fn().mockImplementation(
      async function* (_session: ChatSession, _input: string) {
        yield `\x11${response}`;
      },
    ),
    provider: {},
    mcpRegistry: undefined,
  } as any;
}

/** A valid inbound text message. */
function msg(overrides: Partial<WhatsAppInbound> = {}): WhatsAppInbound {
  return {
    from: "5491100001234",
    id: "wamid.test",
    body: "hola",
    type: "text",
    timestamp: String(Math.floor(Date.now() / 1000)),
    phoneNumberId: PHONE_NUMBER_ID,
    ...overrides,
  };
}

/** Captures Graph API calls. */
function mockFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify({ messages: [{ id: "gmsg.1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fn, calls };
}

beforeEach(() => {
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", ACCESS_TOKEN);
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_NUMBER_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createWhatsAppChannel", () => {
  it("runs an agent turn and sends the reply via the Graph API", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const agent = mockAgent("Hello from REI!");
    const channel = createWhatsAppChannel(agent, "/tmp/ws");

    await channel.handleInbound!(msg());

    // Agent was called with the prompt.
    expect(agent.streamTurn).toHaveBeenCalledTimes(1);
    const [, input] = (agent.streamTurn as any).mock.calls[0];
    expect(input).toBe("hola");

    // Graph API was called with the reply.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(PHONE_NUMBER_ID);
    // The fixture sender is an Argentine mobile: the reply goes to the listed form, without the 9.
    expect(calls[0].body.to).toBe("541100001234");
    expect(calls[0].body.text.body).toBe("Hello from REI!");
  });

  it("rejects slash-commands without running the agent", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const agent = mockAgent("should not appear");
    const channel = createWhatsAppChannel(agent, "/tmp/ws");

    await channel.handleInbound!(msg({ body: "/runplan", id: "wamid.cmd" }));

    expect(agent.streamTurn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text.body).toMatch(/not available/i);
  });

  it("rejects non-text messages with a friendly reply", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const agent = mockAgent("nope");
    const channel = createWhatsAppChannel(agent, "/tmp/ws");

    await channel.handleInbound!(msg({ type: "image", body: "", id: "wamid.img" }));

    expect(agent.streamTurn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text.body).toMatch(/text/i);
  });

  it("serializes turns for the same number (second waits for first)", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);

    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => (resolveFirst = r));
    const agent = {
      streamTurn: vi.fn().mockImplementation(
        async function* (_s: ChatSession, input: string) {
          if (input === "first") await firstDone;
          yield `\x11reply to ${input}`;
        },
      ),
      provider: {},
      mcpRegistry: undefined,
    } as any;

    const channel = createWhatsAppChannel(agent, "/tmp/ws");
    const p1 = channel.handleInbound!(msg({ body: "first", id: "wamid.s1" }));
    const p2 = channel.handleInbound!(msg({ body: "second", id: "wamid.s2" }));

    // The second turn must not start until the first resolves.
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.streamTurn).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await Promise.all([p1, p2]);
    expect(agent.streamTurn).toHaveBeenCalledTimes(2);
  });

  it("runs turns for different numbers in parallel", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);

    let resolveA: () => void;
    const aDone = new Promise<void>((r) => (resolveA = r));
    const agent = {
      streamTurn: vi.fn().mockImplementation(
        async function* (_s: ChatSession, input: string) {
          if (input === "from-a") await aDone;
          yield `\x11ok ${input}`;
        },
      ),
      provider: {},
      mcpRegistry: undefined,
    } as any;

    const channel = createWhatsAppChannel(agent, "/tmp/ws");
    const pA = channel.handleInbound!(msg({ from: "111", body: "from-a", id: "wamid.a" }));
    const pB = channel.handleInbound!(msg({ from: "222", body: "from-b", id: "wamid.b" }));

    // Both should have started (different sessions, no serialization between them).
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.streamTurn).toHaveBeenCalledTimes(2);

    resolveA!();
    await Promise.all([pA, pB]);
  });

  it("replies to an Argentine mobile without the 9 — the format Meta's recipient list holds", async () => {
    // Inbound `from` (the wa_id) is 549 + area + number; Meta's allowed-recipient list stores the
    // same phone as 54 + area + number. Sending to the wa_id fails with 131030 "Recipient phone
    // number not in allowed list" even though Meta's own test messages reach the phone.
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const channel = createWhatsAppChannel(mockAgent("hola"), "/tmp/rei-wa-ar");
    await channel.handleInbound!(msg({ id: "wamid.ar", from: "5493410000000" }));
    expect(calls[0].body.to).toBe("543410000000");
  });

  it("leaves every other number as it arrived", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const channel = createWhatsAppChannel(mockAgent("hi"), "/tmp/rei-wa-other");
    await channel.handleInbound!(msg({ id: "wamid.us", from: "14155550123" }));
    await channel.handleInbound!(msg({ id: "wamid.ar-landline", from: "543410005678" }));
    expect(calls.map((c) => c.body.to)).toEqual(["14155550123", "543410005678"]);
  });

  it("chunks responses longer than 4096 chars into multiple Graph API calls", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const longText = "x".repeat(5000);
    const agent = mockAgent(longText);
    const channel = createWhatsAppChannel(agent, "/tmp/ws");

    await channel.handleInbound!(msg({ id: "wamid.long" }));

    // 5000 chars → 2 chunks (4096 + 904).
    expect(calls).toHaveLength(2);
    expect(calls[0].body.text.body).toHaveLength(4096);
    expect(calls[1].body.text.body).toHaveLength(904);
  });

  it("skips the agent when the 24h window has expired", async () => {
    const { fn, calls } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const agent = mockAgent("too late");
    const channel = createWhatsAppChannel(agent, "/tmp/ws");

    // Timestamp 25 hours ago.
    const stale = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    await channel.handleInbound!(msg({ timestamp: stale, id: "wamid.stale" }));

    expect(agent.streamTurn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("runs the turn with read-only tools only — never run_command", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const agent = mockAgent("ok");
    await createWhatsAppChannel(agent, "/tmp/rei-wa-test").handleInbound(msg({ id: "wamid.tools" }));
    const options = agent.streamTurn.mock.calls[0][2];
    expect(options.allowedTools).toEqual(["read_files", "grep_code", "list_files"]);
  });

  it("forces the session mode to ask", async () => {
    const { fn } = mockFetch();
    vi.stubGlobal("fetch", fn);
    const agent = mockAgent("safe");
    const channel = createWhatsAppChannel(agent, "/tmp/ws");

    await channel.handleInbound!(msg({ id: "wamid.mode" }));

    const [session] = (agent.streamTurn as any).mock.calls[0];
    expect(session.mode).toBe("ask");
  });

  it("logs status events without side effects", () => {
    const agent = mockAgent("x");
    const channel = createWhatsAppChannel(agent, "/tmp/ws");
    const spy = vi.spyOn(console, "log");

    const status: WhatsAppStatus = {
      id: "wamid.s",
      status: "delivered",
      recipientId: "5491100001234",
      timestamp: "1790375830",
    };
    channel.onStatus?.(status);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("delivered"));
    spy.mockRestore();
  });
});
