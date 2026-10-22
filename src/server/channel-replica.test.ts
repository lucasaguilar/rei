import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChannelReplica } from "./channel-replica.js";
import type { BackendApi, BackendConversation } from "./backend-api.js";

/**
 * The replica is shared by every public channel: each one names its channel and its contact key,
 * and only WhatsApp adds Meta's fields. These tests drive it as the web channel will.
 */

const KEY = "web_3f2b9c1e-0000-4000-8000-000000000001";

function fakeApi(open: BackendConversation | null = null) {
  return {
    ensureContact: vi.fn(async (key: string) => ({ id: "c-9", wa_id: key })),
    findOpenConversation: vi.fn(async () => open),
    createConversation: vi.fn(async (contactId: string) => ({
      id: "conv-web",
      contact_id: contactId,
      status: "assistant" as const,
    })),
    addMessage: vi.fn(async () => {}),
  } satisfies BackendApi;
}

const maskKey = (key: string) => `web_…${key.slice(-4)}`;
let errors: string[];
const logError = (line: string) => void errors.push(line);

beforeEach(() => {
  errors = [];
});
afterEach(() => vi.restoreAllMocks());

describe("createChannelReplica", () => {
  it("without a backend does nothing and reports no status", async () => {
    const replica = createChannelReplica(null, { channel: "web", maskKey, logError });
    expect(await replica.recordInbound({ key: KEY, content: "hola" })).toBeNull();
    await expect(replica.recordReply(KEY, "hi")).resolves.toBeUndefined();
  });

  it("creates a web contact and a web conversation, and stores the message without Meta fields", async () => {
    const api = fakeApi();
    const replica = createChannelReplica(api, { channel: "web", maskKey, logError });

    expect(await replica.recordInbound({ key: KEY, content: "hola", name: "Ana" })).toBe("assistant");
    expect(api.ensureContact).toHaveBeenCalledWith(KEY, "Ana", "web");
    expect(api.createConversation).toHaveBeenCalledWith("c-9", "web");
    expect(api.addMessage).toHaveBeenCalledWith("conv-web", { role: "user", content: "hola" });
  });

  it("stores the reply in the conversation of the key's last inbound", async () => {
    const api = fakeApi({ id: "conv-1", contact_id: "c-9", status: "assistant" });
    const replica = createChannelReplica(api, { channel: "web", maskKey, logError });
    await replica.recordInbound({ key: KEY, content: "hola" });

    await replica.recordReply(KEY, "¡Hola!");

    expect(api.addMessage).toHaveBeenLastCalledWith("conv-1", { role: "assistant", content: "¡Hola!" });
  });

  it("reports 'human' so the channel stands down, and still stores the message", async () => {
    const api = fakeApi({ id: "conv-1", contact_id: "c-9", status: "human" });
    const replica = createChannelReplica(api, { channel: "web", maskKey, logError });
    expect(await replica.recordInbound({ key: KEY, content: "hola" })).toBe("human");
    expect(api.addMessage).toHaveBeenCalledWith("conv-1", { role: "user", content: "hola" });
  });

  it("a failure never throws and logs through the channel, with the key masked", async () => {
    const api = fakeApi();
    api.createConversation.mockRejectedValueOnce(new Error("backend POST /conversations → 500"));
    const replica = createChannelReplica(api, { channel: "web", maskKey, logError });

    expect(await replica.recordInbound({ key: KEY, content: "hola" })).toBeNull();
    expect(errors.join("\n")).toContain("500");
    expect(errors.join("\n")).toContain(maskKey(KEY));
    expect(errors.join("\n")).not.toContain(KEY);
  });
});
