import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWhatsAppReplica } from "./whatsapp-replica.js";
import type { BackendApi, BackendConversation } from "./backend-api.js";
import type { WhatsAppInbound } from "./whatsapp-webhook.js";

/**
 * The replica mirrors each WhatsApp exchange into rei-backend-api for the dashboard. It is
 * best-effort by design: the local session is the agent's source of truth, so a backend failure
 * must cost a row in the dashboard, never the customer's answer.
 */

const FROM = "5491100001234";

function msg(overrides: Partial<WhatsAppInbound> = {}): WhatsAppInbound {
  return {
    from: FROM,
    id: "wamid.1",
    body: "hola",
    type: "text",
    timestamp: "1790375830",
    phoneNumberId: "1000000000000001",
    ...overrides,
  };
}

/** A backend with one contact and, unless told otherwise, no open conversation yet. */
function fakeApi(open: BackendConversation | null = null) {
  return {
    ensureContact: vi.fn(async (waId: string) => ({ id: "c-1", wa_id: waId })),
    findOpenConversation: vi.fn(async () => open),
    createConversation: vi.fn(async (contactId: string) => ({
      id: "conv-new",
      contact_id: contactId,
      status: "assistant" as const,
    })),
    addMessage: vi.fn(async () => {}),
  } satisfies BackendApi;
}

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("createWhatsAppReplica", () => {
  it("without a backend does nothing and reports no status", async () => {
    const replica = createWhatsAppReplica(null);
    expect(await replica.recordInbound(msg())).toBeNull();
    await expect(replica.recordReply(FROM, "hi", "gmsg.1")).resolves.toBeUndefined();
  });

  it("first message: creates the conversation and stores the user message with Meta's id and time", async () => {
    const api = fakeApi();
    const status = await createWhatsAppReplica(api).recordInbound(msg());

    expect(status).toBe("assistant");
    expect(api.ensureContact).toHaveBeenCalledWith(FROM, undefined);
    expect(api.createConversation).toHaveBeenCalledWith("c-1");
    expect(api.addMessage).toHaveBeenCalledWith("conv-new", {
      role: "user",
      content: "hola",
      wa_message_id: "wamid.1",
      wa_timestamp: "1790375830",
    });
  });

  it("passes the WhatsApp profile name to the contact", async () => {
    const api = fakeApi();
    await createWhatsAppReplica(api).recordInbound(msg(), "Ana");
    expect(api.ensureContact).toHaveBeenCalledWith(FROM, "Ana");
  });

  it("caches the contact, but asks for the conversation on EVERY message", async () => {
    // The status is how an operator's takeover reaches REI: caching it would let the bot keep
    // answering a conversation a human already took.
    const api = fakeApi({ id: "conv-1", contact_id: "c-1", status: "assistant" });
    const replica = createWhatsAppReplica(api);

    await replica.recordInbound(msg({ id: "wamid.1" }));
    await replica.recordInbound(msg({ id: "wamid.2" }));

    expect(api.ensureContact).toHaveBeenCalledTimes(1);
    expect(api.findOpenConversation).toHaveBeenCalledTimes(2);
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("reports 'human' and still records the message, so the operator sees it", async () => {
    const api = fakeApi({ id: "conv-1", contact_id: "c-1", status: "human" });
    expect(await createWhatsAppReplica(api).recordInbound(msg())).toBe("human");
    expect(api.addMessage).toHaveBeenCalledWith("conv-1", expect.objectContaining({ role: "user" }));
  });

  it("records a non-text message as a placeholder — it reopens Meta's 24h window too", async () => {
    const api = fakeApi();
    await createWhatsAppReplica(api).recordInbound(msg({ type: "image", body: "" }));
    expect(api.addMessage).toHaveBeenCalledWith(
      "conv-new",
      expect.objectContaining({ content: "[image]", wa_timestamp: "1790375830" }),
    );
  });

  it("recordReply stores the answer in the conversation of the last inbound, with the Graph id", async () => {
    const api = fakeApi({ id: "conv-1", contact_id: "c-1", status: "assistant" });
    const replica = createWhatsAppReplica(api);
    await replica.recordInbound(msg());

    await replica.recordReply(FROM, "¡Hola!", "gmsg.1");

    expect(api.addMessage).toHaveBeenLastCalledWith("conv-1", {
      role: "assistant",
      content: "¡Hola!",
      wa_message_id: "gmsg.1",
    });
  });

  it("recordReply without a Graph id sends no wa_message_id", async () => {
    const api = fakeApi({ id: "conv-1", contact_id: "c-1", status: "assistant" });
    const replica = createWhatsAppReplica(api);
    await replica.recordInbound(msg());

    await replica.recordReply(FROM, "¡Hola!", null);

    expect(api.addMessage).toHaveBeenLastCalledWith("conv-1", { role: "assistant", content: "¡Hola!" });
  });

  it("recordReply without a recorded inbound has nowhere to go, so it sends nothing", async () => {
    const api = fakeApi();
    await createWhatsAppReplica(api).recordReply(FROM, "¡Hola!", "gmsg.1");
    expect(api.addMessage).not.toHaveBeenCalled();
  });

  it("a backend failure never throws: it logs, masked, and reports no status", async () => {
    const api = fakeApi();
    api.addMessage.mockRejectedValueOnce(new Error("backend POST /conversations/conv-new/messages → 503"));

    expect(await createWhatsAppReplica(api).recordInbound(msg())).toBeNull();
    expect(errors.join("\n")).toContain("503");
    expect(errors.join("\n")).toContain("…1234");
    expect(errors.join("\n")).not.toContain(FROM);
  });

  it("after a failure it forgets the contact, so a contact deleted in the dashboard heals", async () => {
    const api = fakeApi();
    const replica = createWhatsAppReplica(api);
    await replica.recordInbound(msg({ id: "wamid.1" }));
    api.findOpenConversation.mockRejectedValueOnce(new Error("backend GET … → 500"));
    await replica.recordInbound(msg({ id: "wamid.2" }));

    await replica.recordInbound(msg({ id: "wamid.3" }));

    expect(api.ensureContact).toHaveBeenCalledTimes(2);
  });

  it("a failed reply leaves the customer unaffected and is logged", async () => {
    const api = fakeApi({ id: "conv-1", contact_id: "c-1", status: "assistant" });
    const replica = createWhatsAppReplica(api);
    await replica.recordInbound(msg());
    api.addMessage.mockRejectedValueOnce(new Error("backend POST … → 429"));

    await expect(replica.recordReply(FROM, "¡Hola!", "gmsg.1")).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("429");
  });
});
