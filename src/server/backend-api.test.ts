import { describe, it, expect, vi } from "vitest";
import { createBackendApi } from "./backend-api.js";

/**
 * The thin HTTP client for rei-backend-api — the NestJS service that replicates WhatsApp
 * conversations into Supabase for the dashboard. These tests pin the wire contract the backend
 * actually implements (src/{contacts,conversations}/*.controller.ts there), not an idealized one.
 */

const ENV = { REI_BACKEND_URL: "https://backend.test/", REI_BACKEND_API_KEY: "test-key" };

/** Records every call and answers with the queued responses, in order. */
function mockFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body as string) : null });
    return responses.shift() ?? new Response("", { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

describe("createBackendApi", () => {
  it("is null without REI_BACKEND_URL, so the channel behaves exactly as before", () => {
    expect(createBackendApi({})).toBeNull();
    expect(createBackendApi({ REI_BACKEND_URL: "  " })).toBeNull();
  });

  it("ensureContact posts the raw wa_id with the API key, without a double slash", async () => {
    const { fn, calls } = mockFetch(json({ id: "c-1", wa_id: "5491100001234" }));
    const api = createBackendApi(ENV, fn)!;

    const contact = await api.ensureContact("5491100001234");

    expect(contact.id).toBe("c-1");
    expect(calls[0].url).toBe("https://backend.test/contacts");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(calls[0].body).toEqual({ wa_id: "5491100001234", phone: "+5491100001234" });
  });

  it("findOpenConversation reads Nest's empty 200 body as 'no open conversation'", async () => {
    const { fn, calls } = mockFetch(new Response("", { status: 200 }));
    const api = createBackendApi(ENV, fn)!;

    expect(await api.findOpenConversation("c 1")).toBeNull();
    expect(calls[0].url).toBe("https://backend.test/conversations/by-contact/c%201");
    expect(calls[0].init.method).toBe("GET");
  });

  it("findOpenConversation returns the conversation with its status", async () => {
    const { fn } = mockFetch(json({ id: "conv-1", contact_id: "c-1", status: "human" }));
    const api = createBackendApi(ENV, fn)!;

    expect(await api.findOpenConversation("c-1")).toMatchObject({ id: "conv-1", status: "human" });
  });

  it("createConversation posts the contact id", async () => {
    const { fn, calls } = mockFetch(json({ id: "conv-2", contact_id: "c-1", status: "assistant" }));
    const api = createBackendApi(ENV, fn)!;

    expect((await api.createConversation("c-1")).id).toBe("conv-2");
    expect(calls[0].url).toBe("https://backend.test/conversations");
    expect(calls[0].body).toEqual({ contact_id: "c-1" });
  });

  it("addMessage posts role, content and the Meta message id", async () => {
    const { fn, calls } = mockFetch(json({ id: "m-1" }));
    const api = createBackendApi(ENV, fn)!;

    await api.addMessage("conv-1", { role: "user", content: "hola", wa_message_id: "wamid.1" });

    expect(calls[0].url).toBe("https://backend.test/conversations/conv-1/messages");
    expect(calls[0].body).toEqual({ role: "user", content: "hola", wa_message_id: "wamid.1" });
  });

  it("throws on a non-2xx with the status, and never echoes the API key", async () => {
    const { fn } = mockFetch(new Response("Invalid or missing API key", { status: 401 }));
    const api = createBackendApi(ENV, fn)!;

    const err = await api.ensureContact("5491100001234").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain("test-key");
  });

  it("bounds every request with a timeout signal", async () => {
    const { fn, calls } = mockFetch(json({ id: "c-1" }));
    await createBackendApi(ENV, fn)!.ensureContact("1");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
