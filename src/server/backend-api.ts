/**
 * @fileoverview Thin HTTP client for rei-backend-api — the NestJS service (Render + Supabase)
 * that replicates WhatsApp conversations for the dashboard. REI never talks to Supabase directly:
 * only the backend holds the service_role key.
 *
 * The local session JSON stays the agent's source of context; this client only REPLICATES what
 * happened, plus reads the conversation status (an operator may have taken it over).
 *
 * @module rei/server/backend-api
 */

/** A request that hangs must not hold a WhatsApp turn hostage. */
const REQUEST_TIMEOUT_MS = 10_000;

/** `assistant` = REI answers; `human` = an operator took it over. Was `bot` before backend PR #9. */
export type ConversationStatus = "assistant" | "human" | "closed";

export interface BackendContact {
  id: string;
  wa_id: string;
}

export interface BackendConversation {
  id: string;
  contact_id: string;
  status: ConversationStatus;
}

export interface BackendMessageInput {
  role: "user" | "assistant";
  content: string;
  wa_message_id?: string;
}

export interface BackendApi {
  /** findOrCreate on the backend: idempotent, so no GET-then-POST round trip is needed. */
  ensureContact(waId: string): Promise<BackendContact>;
  /** The newest `bot`/`human` conversation of the contact, or null when none is open. */
  findOpenConversation(contactId: string): Promise<BackendConversation | null>;
  createConversation(contactId: string): Promise<BackendConversation>;
  addMessage(conversationId: string, message: BackendMessageInput): Promise<void>;
}

/**
 * Builds the client from the environment, or returns null when REI_BACKEND_URL is unset — the
 * channel then skips replication entirely and behaves as it did before the backend existed.
 */
export function createBackendApi(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): BackendApi | null {
  const base = env.REI_BACKEND_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  const apiKey = env.REI_BACKEND_API_KEY?.trim() ?? "";

  const request = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Method, path and status only: this lands in hosted logs, and a response body may echo
    // the customer's message back.
    if (!res.ok) throw new Error(`backend ${method} ${path} → ${res.status}`);
    // Nest serializes a `null` return as an empty 200, not as `null` JSON.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const id = encodeURIComponent;

  return {
    async ensureContact(waId) {
      return (await request("POST", "/contacts", { wa_id: waId, phone: `+${waId}` })) as BackendContact;
    },
    async findOpenConversation(contactId) {
      return (await request("GET", `/conversations/by-contact/${id(contactId)}`)) as BackendConversation | null;
    },
    async createConversation(contactId) {
      return (await request("POST", "/conversations", { contact_id: contactId })) as BackendConversation;
    },
    async addMessage(conversationId, message) {
      await request("POST", `/conversations/${id(conversationId)}/messages`, message);
    },
  };
}
