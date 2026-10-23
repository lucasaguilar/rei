import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebChannel, type WebMessage } from "./web-channel.js";
import type { PublicChannel } from "./public-channel.js";
import type { ChannelInbound, ChannelReplica } from "./channel-replica.js";
import type { ConversationStatus } from "./backend-api.js";

/**
 * The web channel answers a widget visitor through the same public-channel core as WhatsApp: one
 * session per visitor, ask-only, replicated to the conversation store, silent when an operator
 * has the conversation. These tests drive it without HTTP (web-http.test.ts covers the transport).
 */

const SESSION = "3f2b9c1e-0000-4000-8000-000000000001";

/** `reply` may come in pieces, the way a model writes it; the turn returns them joined. */
function fakeChannel(reply: string | string[] = "¡Hola!") {
  const turns: Array<{ key: string; prompt: string }> = [];
  const pieces = Array.isArray(reply) ? reply : [reply];
  const channel: PublicChannel = {
    enqueue: async (_key, task) => task(),
    turn: vi.fn(async (key: string, prompt: string, onText?: (text: string) => void) => {
      turns.push({ key, prompt });
      for (const p of pieces) onText?.(p);
      return pieces.join("");
    }),
  };
  return { channel, turns };
}

function fakeReplica(status: ConversationStatus | null = "assistant") {
  const inbound: ChannelInbound[] = [];
  const replies: Array<{ key: string; text: string }> = [];
  const replica: ChannelReplica = {
    recordInbound: async (i) => {
      inbound.push(i);
      return status;
    },
    recordReply: async (key, text) => void replies.push({ key, text }),
  };
  return { replica, inbound, replies };
}

const message = (overrides: Partial<WebMessage> = {}): WebMessage => ({
  sessionId: SESSION,
  content: "hola",
  ip: "203.0.113.7",
  ...overrides,
});

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
  vi.spyOn(console, "error").mockImplementation((l: string) => void logs.push(l));
});
afterEach(() => vi.restoreAllMocks());

describe("createWebChannel", () => {
  it("answers with the turn's reply on the visitor's own session, and records both sides", async () => {
    const { channel, turns } = fakeChannel("¡Hola! ¿En qué te ayudo?");
    const { replica, inbound, replies } = fakeReplica();

    const result = await createWebChannel(channel, replica).handleMessage(message({ name: "Ana" }));

    expect(result).toEqual({ status: 200, body: { reply: "¡Hola! ¿En qué te ayudo?", status: "assistant" } });
    expect(turns).toEqual([{ key: SESSION, prompt: "hola" }]);
    expect(inbound).toEqual([{ key: `web_${SESSION}`, content: "hola", name: "Ana" }]);
    expect(replies).toEqual([{ key: `web_${SESSION}`, text: "¡Hola! ¿En qué te ayudo?" }]);
  });

  it("streams the reply's pieces to onText, without the blank lines a model may open with", async () => {
    const { channel } = fakeChannel(["\n\n", "  ¡Ho", "la! ", "¿Qué tal?"]);
    const { replica, replies } = fakeReplica();
    const pieces: string[] = [];

    const result = await createWebChannel(channel, replica).handleMessage(message(), (t) => pieces.push(t));

    expect(pieces).toEqual(["¡Ho", "la! ", "¿Qué tal?"]);
    expect(result.body.reply).toBe("¡Hola! ¿Qué tal?");
    expect(replies).toEqual([{ key: `web_${SESSION}`, text: "¡Hola! ¿Qué tal?" }]);
  });

  it("stays silent when an operator has the conversation, but the message was recorded", async () => {
    const { channel, turns } = fakeChannel();
    const { replica, inbound } = fakeReplica("human");

    const result = await createWebChannel(channel, replica).handleMessage(message());

    expect(result).toEqual({ status: 200, body: { reply: null, status: "human" } });
    expect(turns).toHaveLength(0);
    expect(inbound).toHaveLength(1);
  });

  it("refuses slash commands without running a turn — a visitor must not drive the agent", async () => {
    const { channel, turns } = fakeChannel();
    const { replica, replies } = fakeReplica();

    const result = await createWebChannel(channel, replica).handleMessage(message({ content: "/mode agent" }));

    expect(result.status).toBe(200);
    expect(result.body.reply).toMatch(/not available/i);
    expect(turns).toHaveLength(0);
    expect(replies).toHaveLength(1);
  });

  it("limits each session per minute, before anything that costs", async () => {
    const { channel, turns } = fakeChannel();
    const { replica, inbound } = fakeReplica();
    const web = createWebChannel(channel, replica, { perSession: 2, perIp: 100 });

    await web.handleMessage(message());
    await web.handleMessage(message());
    const third = await web.handleMessage(message());

    expect(third.status).toBe(429);
    expect(third.body.status).toBe("rate_limited");
    expect(third.body.reply).toMatch(/too fast/i);
    expect(turns).toHaveLength(2);
    expect(inbound).toHaveLength(2);
  });

  it("limits each IP across sessions — new session ids must not reset the budget", async () => {
    const { channel, turns } = fakeChannel();
    const { replica } = fakeReplica();
    const web = createWebChannel(channel, replica, { perSession: 100, perIp: 2 });

    await web.handleMessage(message({ sessionId: "session-aaaaaaaa" }));
    await web.handleMessage(message({ sessionId: "session-bbbbbbbb" }));
    const third = await web.handleMessage(message({ sessionId: "session-cccccccc" }));

    expect(third.status).toBe(429);
    expect(turns).toHaveLength(2);
  });

  it("a failed turn answers with an apology and logs, masked", async () => {
    const { channel } = fakeChannel();
    vi.mocked(channel.turn).mockRejectedValueOnce(new Error("model down"));
    const { replica } = fakeReplica();

    const result = await createWebChannel(channel, replica).handleMessage(message());

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ status: "error" });
    expect(result.body.reply).toMatch(/something went wrong/i);
    expect(logs.join("\n")).toContain("model down");
    expect(logs.join("\n")).not.toContain(SESSION);
  });
});
