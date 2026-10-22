/**
 * @fileoverview Thin HTTP client for an external conversation store: any service that implements
 * the contract below, so a human team can follow public-channel conversations and take one over.
 * REI only knows this contract, never the store's database.
 *
 * The local session JSON stays the agent's source of context; this client only REPLICATES what
 * happened, plus reads the conversation status (an operator may have taken it over).
 *
 * Contract (all requests carry `Authorization: Bearer $REI_BACKEND_API_KEY`):
 *   POST /contacts                            { wa_id, phone?, name? }  → { id, wa_id }  find-or-create
 *   GET  /conversations/by-contact/:contactId                           → { id, contact_id, status } | empty
 *   POST /conversations                       { contact_id, channel }   → { id, contact_id, status }
 *   POST /conversations/:id/messages          { role, content, wa_message_id?, wa_timestamp? }
 *
 * `wa_id` is the store's contact key for every channel: the WhatsApp number, or `web_<session>` for
 * a web visitor (who has no phone). The store decides when a conversation ends, per channel.
 *
 * @module rei/server/backend-api
 */

/** A request that hangs must not hold a WhatsApp turn hostage. */
const REQUEST_TIMEOUT_MS = 10_000;

/** `assistant` = REI answers; `human` = an operator took it over; `closed` = finished. */
export type ConversationStatus = "assistant" | "human" | "closed";

/** The public channel a contact and a conversation belong to. */
export type ConversationChannel = "whatsapp" | "web";

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
  /** Meta's epoch-seconds string, as delivered. Only inbound messages have one: the 24h window
   *  counts from the customer's last message, not from when the backend stored it. */
  wa_timestamp?: string;
}

export interface BackendApi {
  /** findOrCreate on the backend: idempotent, so no GET-then-POST round trip is needed. A `name`
   *  also updates an existing contact's. Only a WhatsApp key is a phone number. */
  ensureContact(key: string, name?: string, channel?: ConversationChannel): Promise<BackendContact>;
  /** The newest `bot`/`human` conversation of the contact, or null when none is open. */
  findOpenConversation(contactId: string): Promise<BackendConversation | null>;
  createConversation(contactId: string, channel?: ConversationChannel): Promise<BackendConversation>;
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
    // "None" may come back as an empty 200 rather than `null` JSON (frameworks that serialize a
    // null return that way do), so both read as null.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const id = encodeURIComponent;

  return {
    async ensureContact(key, name, channel = "whatsapp") {
      const body = {
        wa_id: key,
        ...(channel === "whatsapp" ? { phone: `+${key}` } : {}),
        ...(name ? { name } : {}),
      };
      return (await request("POST", "/contacts", body)) as BackendContact;
    },
    async findOpenConversation(contactId) {
      return (await request("GET", `/conversations/by-contact/${id(contactId)}`)) as BackendConversation | null;
    },
    async createConversation(contactId, channel = "whatsapp") {
      return (await request("POST", "/conversations", { contact_id: contactId, channel })) as BackendConversation;
    },
    async addMessage(conversationId, message) {
      await request("POST", `/conversations/${id(conversationId)}/messages`, message);
    },
  };
}
