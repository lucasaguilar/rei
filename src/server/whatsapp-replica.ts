/**
 * @fileoverview The WhatsApp side of the channel replica (channel-replica.ts): keys contacts by
 * number and adds Meta's message ids and timestamp, which the store uses for the 24h window.
 *
 * @module rei/server/whatsapp-replica
 */
import type { BackendApi, ConversationStatus } from "./backend-api.js";
import type { WhatsAppInbound } from "./whatsapp-webhook.js";
import { createChannelReplica } from "./channel-replica.js";
import { waError, maskNumber, maskMessageId } from "./whatsapp-log.js";

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
  const replica = createChannelReplica(api, { channel: "whatsapp", maskKey: maskNumber, logError: waError });

  return {
    recordInbound(msg, profileName) {
      return replica.recordInbound({
        key: msg.from,
        content: inboundContent(msg),
        name: profileName,
        label: maskMessageId(msg.id),
        fields: { wa_message_id: msg.id, ...(msg.timestamp ? { wa_timestamp: msg.timestamp } : {}) },
      });
    },

    recordReply(from, text, graphMessageId) {
      return replica.recordReply(from, text, graphMessageId ? { wa_message_id: graphMessageId } : undefined);
    },
  };
}
