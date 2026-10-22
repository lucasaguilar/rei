/**
 * @fileoverview Mirrors each public-channel exchange into the external conversation store
 * (backend-api.ts), so the people following conversations see the contact, the conversation and
 * every message. Shared by every channel: each names its channel and its contact key, and only
 * WhatsApp adds Meta's fields (whatsapp-replica.ts).
 *
 * Best-effort by design: the local session is the agent's source of truth, so a store failure
 * costs a row in the replica, never the customer's answer. Nothing here throws.
 *
 * The backend conversation is NOT the REI session: when an operator closes one, or the store ends
 * it (WhatsApp's 24h window, web inactivity), the next message opens a new conversation in the
 * backend while REI keeps the customer's context.
 *
 * @module rei/server/channel-replica
 */
import type { BackendApi, BackendMessageInput, ConversationChannel, ConversationStatus } from "./backend-api.js";

/** Fields only a channel knows how to fill — today, Meta's ids and timestamp on WhatsApp. */
export type ChannelMessageFields = Pick<BackendMessageInput, "wa_message_id" | "wa_timestamp">;

export interface ChannelInbound {
  /** The contact key in the store: the WhatsApp number, or `web_<session>`. */
  key: string;
  content: string;
  name?: string;
  /** What the failure log names the message by (already masked), when the channel has an id. */
  label?: string;
  fields?: ChannelMessageFields;
}

export interface ChannelReplica {
  /**
   * Records the customer's message and returns the conversation status — `human` means an operator
   * has it and REI must not answer. Null when there is no backend or it failed: the caller then
   * answers as it would without a replica.
   */
  recordInbound(inbound: ChannelInbound): Promise<ConversationStatus | null>;
  /** Records REI's answer in the conversation of the key's last recorded inbound. */
  recordReply(key: string, text: string, fields?: ChannelMessageFields): Promise<void>;
}

export interface ChannelReplicaOptions {
  channel: ConversationChannel;
  /** Hosted logs must never carry a whole contact key: a phone number, or a session id. */
  maskKey: (key: string) => string;
  logError: (line: string) => void;
}

export function createChannelReplica(api: BackendApi | null, options: ChannelReplicaOptions): ChannelReplica {
  if (!api) {
    return { recordInbound: async () => null, recordReply: async () => {} };
  }
  const { channel, maskKey, logError } = options;

  // Nothing about the contact or the conversation is cached: a contact can be deleted in the store
  // at any time (a cached id then fails the next message on a foreign key), and the status is how
  // an operator's takeover reaches REI. ensureContact is a find-or-create, so asking every time
  // costs one request and never duplicates.
  // Where recordReply writes: the conversation the key's last inbound went to.
  const conversationIds = new Map<string, string>();

  return {
    async recordInbound({ key, content, name, label, fields }) {
      try {
        const contactId = (await api.ensureContact(key, name, channel)).id;
        const conversation =
          (await api.findOpenConversation(contactId)) ?? (await api.createConversation(contactId, channel));
        conversationIds.set(key, conversation.id);
        await api.addMessage(conversation.id, { role: "user", content, ...fields });
        return conversation.status;
      } catch (err) {
        // The reply must not land in a conversation this message never reached.
        conversationIds.delete(key);
        logError(`✗ replica: inbound ${label ? `${label} ` : ""}from ${maskKey(key)} not stored: ${describe(err)}`);
        return null;
      }
    },

    async recordReply(key, text, fields) {
      const conversationId = conversationIds.get(key);
      if (!conversationId) return;
      try {
        await api.addMessage(conversationId, { role: "assistant", content: text, ...fields });
      } catch (err) {
        logError(`✗ replica: reply to ${maskKey(key)} not stored: ${describe(err)}`);
      }
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
