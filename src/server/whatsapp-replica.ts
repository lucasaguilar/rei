/**
 * @fileoverview Mirrors each WhatsApp exchange into the external conversation store (backend-api.ts),
 * so the people following conversations see the contact, the conversation and every message.
 *
 * Best-effort by design: the local session (`wa-<number>.json`) is the agent's source of truth, so
 * a store failure costs a row in the replica, never the customer's answer. Nothing here throws.
 *
 * The backend conversation is NOT the REI session: when an operator closes one, the next message
 * opens a new conversation in the backend while REI keeps the customer's context (plan decision 10).
 *
 * @module rei/server/whatsapp-replica
 */
import type { BackendApi, ConversationStatus } from "./backend-api.js";
import type { WhatsAppInbound } from "./whatsapp-webhook.js";
import { waError, maskNumber } from "./whatsapp-log.js";

export interface WhatsAppReplica {
  /**
   * Records the customer's message and returns the conversation status — `human` means an operator
   * has it and REI must not answer. Null when there is no backend or it failed: the caller then
   * answers as it would without a replica.
   */
  recordInbound(msg: WhatsAppInbound, profileName?: string): Promise<ConversationStatus | null>;
  /** Records REI's answer in the conversation of the number's last recorded inbound. */
  recordReply(from: string, text: string, graphMessageId: string | null): Promise<void>;
}

/** An image or a voice note reopens Meta's 24h window like text does, so it is recorded too. */
function inboundContent(msg: WhatsAppInbound): string {
  return msg.type === "text" ? msg.body : `[${msg.type}]`;
}

export function createWhatsAppReplica(api: BackendApi | null): WhatsAppReplica {
  if (!api) {
    return { recordInbound: async () => null, recordReply: async () => {} };
  }

  // The contact id never changes for a number, so it is cached. The conversation is not: its
  // status is how an operator's takeover reaches REI, and it must be read on every message.
  const contactIds = new Map<string, string>();
  // Where recordReply writes: the conversation the number's last inbound went to.
  const conversationIds = new Map<string, string>();

  return {
    async recordInbound(msg, profileName) {
      try {
        let contactId = contactIds.get(msg.from);
        if (!contactId) {
          contactId = (await api.ensureContact(msg.from, profileName)).id;
          contactIds.set(msg.from, contactId);
        }
        const conversation =
          (await api.findOpenConversation(contactId)) ?? (await api.createConversation(contactId));
        conversationIds.set(msg.from, conversation.id);
        await api.addMessage(conversation.id, {
          role: "user",
          content: inboundContent(msg),
          wa_message_id: msg.id,
          ...(msg.timestamp ? { wa_timestamp: msg.timestamp } : {}),
        });
        return conversation.status;
      } catch (err) {
        // A contact deleted in the store would fail forever from the cache; re-resolve it.
        contactIds.delete(msg.from);
        conversationIds.delete(msg.from);
        waError(`✗ replica: inbound ${msg.id} from ${maskNumber(msg.from)} not stored: ${describe(err)}`);
        return null;
      }
    },

    async recordReply(from, text, graphMessageId) {
      const conversationId = conversationIds.get(from);
      if (!conversationId) return;
      try {
        await api.addMessage(conversationId, {
          role: "assistant",
          content: text,
          ...(graphMessageId ? { wa_message_id: graphMessageId } : {}),
        });
      } catch (err) {
        waError(`✗ replica: reply to ${maskNumber(from)} not stored: ${describe(err)}`);
      }
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
