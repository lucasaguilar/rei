import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWhatsAppChannel } from "./whatsapp-channel.js";
import type { WhatsAppReplica } from "./whatsapp-replica.js";
import type { ConversationStatus } from "./backend-api.js";
import type { WhatsAppInbound } from "./whatsapp-webhook.js";
import type { ChatSession } from "../chat/types.js";

/**
 * How the WhatsApp channel drives the backend replica: every message the customer sends is
 * recorded (it moves Meta's 24h window, and the operator must see it), every reply the customer
 * receives is recorded, and an operator's takeover (`human`) silences REI. The replica itself is
 * faked here; its own behaviour is pinned in whatsapp-replica.test.ts.
 */

const PHONE_NUMBER_ID = "1000000000000001";

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

function mockAgent(response: string) {
  return {
    streamTurn: vi.fn(async function* (_s: ChatSession, _p: string) {
      yield `\x11${response}`;
    }),
  } as any;
}

function fakeReplica(status: ConversationStatus | null = "assistant") {
  return {
    recordInbound: vi.fn(async () => status),
    recordReply: vi.fn(async () => {}),
  } satisfies WhatsAppReplica;
}

/** Graph API: answers every send with a fresh message id. */
function mockGraph() {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(init!.body as string).text.body);
      return new Response(JSON.stringify({ messages: [{ id: `gmsg.${sent.length}` }] }), { status: 200 });
    }),
  );
  return sent;
}

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "rei-wa-replica-"));
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-access-token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_NUMBER_ID);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhatsApp channel → replica", () => {
  it("records the inbound with the profile name, then the reply with its Graph id", async () => {
    mockGraph();
    const replica = fakeReplica();
    const channel = createWhatsAppChannel(mockAgent("¡Hola!"), ws, replica);

    await channel.handleInbound!(msg({ profileName: "Ana" }));

    expect(replica.recordInbound).toHaveBeenCalledWith(expect.objectContaining({ id: "wamid.test" }), "Ana");
    expect(replica.recordReply).toHaveBeenCalledWith("5491100001234", "¡Hola!", "gmsg.1");
  });

  it("an operator's takeover silences REI: no turn, no reply", async () => {
    const sent = mockGraph();
    const replica = fakeReplica("human");
    const agent = mockAgent("should not run");

    await createWhatsAppChannel(agent, ws, replica).handleInbound!(msg());

    expect(agent.streamTurn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(replica.recordReply).not.toHaveBeenCalled();
  });

  it("a non-text message is recorded, and so is the canned answer the customer got", async () => {
    const sent = mockGraph();
    const replica = fakeReplica();
    const agent = mockAgent("should not run");

    await createWhatsAppChannel(agent, ws, replica).handleInbound!(msg({ type: "image", body: "" }));

    expect(agent.streamTurn).not.toHaveBeenCalled();
    expect(replica.recordInbound).toHaveBeenCalledTimes(1);
    expect(replica.recordReply).toHaveBeenCalledWith("5491100001234", sent[0], "gmsg.1");
  });

  it("a message outside the 24h window is recorded (Meta's time) but not answered", async () => {
    const sent = mockGraph();
    const replica = fakeReplica();
    const stale = String(Math.floor(Date.now() / 1000) - 25 * 3600);

    await createWhatsAppChannel(mockAgent("late"), ws, replica).handleInbound!(msg({ timestamp: stale }));

    expect(replica.recordInbound).toHaveBeenCalledWith(expect.objectContaining({ timestamp: stale }), undefined);
    expect(sent).toEqual([]);
  });

  it("a rate-limited message is not recorded — a flood must not become a flood of requests", async () => {
    vi.stubEnv("REI_WHATSAPP_RATE_PER_MIN", "1");
    mockGraph();
    const replica = fakeReplica();
    const channel = createWhatsAppChannel(mockAgent("ok"), ws, replica);

    await channel.handleInbound!(msg({ id: "wamid.1" }));
    await channel.handleInbound!(msg({ id: "wamid.2" }));

    expect(replica.recordInbound).toHaveBeenCalledTimes(1);
  });

  it("with the backend down (no status) the customer is answered as before", async () => {
    const sent = mockGraph();
    await createWhatsAppChannel(mockAgent("still here"), ws, fakeReplica(null)).handleInbound!(msg());
    expect(sent).toEqual(["still here"]);
  });

  it("one number's records never overlap, so its first two messages cannot open two conversations", async () => {
    mockGraph();
    let inFlight = 0;
    let maxInFlight = 0;
    const replica = {
      recordInbound: vi.fn(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return "assistant" as const;
      }),
      recordReply: vi.fn(async () => {}),
    };
    const channel = createWhatsAppChannel(mockAgent("ok"), ws, replica);

    await Promise.all([
      channel.handleInbound!(msg({ id: "wamid.1" })),
      channel.handleInbound!(msg({ id: "wamid.2" })),
    ]);

    expect(maxInFlight).toBe(1);
  });
});
