/**
 * @fileoverview The WhatsApp channel — bridges the webhook (inbound) to the agent (turn) and the
 * Graph API (outbound). One channel instance per server. The customer policy (per-number sessions,
 * ask-only read tools, per-number serialization, the concurrency cap) lives in public-channel.ts;
 * this module keeps only what is Meta's:
 *
 *  - Slash-commands are refused with a WhatsApp reply (the check itself is public-channel's).
 *  - 24h window: Meta only allows replies within 24h of the last inbound; after that the send
 *    would 403, so we skip the agent entirely.
 *  - 4096-char chunking: the Graph API caps text messages at 4096 chars; longer replies are split.
 *
 * @module rei/server/whatsapp-channel
 */
import type { Agent } from "../core/agent.js";
import type { WhatsAppInbound, WhatsAppStatus, WhatsAppWebhookDeps } from "./whatsapp-webhook.js";
import { waLog, waError, maskNumber } from "./whatsapp-log.js";
import { createRateLimiter, turnsPerMinute } from "./whatsapp-limits.js";
import { createPublicChannel, isSlashCommand, type PublicChannel } from "./public-channel.js";

/** WhatsApp Graph API text message limit. */
const MAX_MESSAGE_CHARS = 4096;

/** 24 hours in seconds — Meta's reply window. */
const REPLY_WINDOW_S = 24 * 3600;

/** The Graph API base URL (version pinned; bump when Meta deprecates). */
const GRAPH_BASE = "https://graph.facebook.com/v25.0";

/**
 * Splits text into chunks of at most `max` characters, breaking on newlines when possible to
 * avoid splitting a word mid-character.
 */
function chunkText(text: string, max: number = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer a newline within the window; fall back to a hard cut.
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // no good newline — hard cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * The number to SEND to, for a sender's wa_id. Argentine mobiles arrive as 549 + area + number,
 * but Meta's allowed-recipient list holds the same phone as 54 + area + number, so replying to
 * the wa_id fails with 131030 "Recipient phone number not in allowed list" — while Meta's own
 * test messages, sent to the listed form, arrive fine. Only the send uses this: sessions and the
 * allowlist stay keyed by the wa_id exactly as Meta delivered it.
 */
export function toGraphRecipient(waId: string): string {
  const ar = /^549(\d{10})$/.exec(waId);
  return ar ? `54${ar[1]}` : waId;
}

/**
 * Sends a text message via the WhatsApp Graph API. Returns the message id on success.
 */
async function sendText(
  to: string,
  body: string,
  accessToken: string,
  phoneNumberId: string,
): Promise<string | null> {
  const url = `${GRAPH_BASE}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toGraphRecipient(to),
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    waError(`Graph API ${res.status} sending to ${maskNumber(to)}: ${errBody.slice(0, 200)}`);
    return null;
  }
  const json = (await res.json()) as { messages?: Array<{ id: string }> };
  const id = json.messages?.[0]?.id ?? null;
  waLog(`→ sent ${id ?? "(no id)"} to ${maskNumber(to)}`);
  return id;
}

/**
 * Sends a (possibly long) reply, chunking at the Graph API limit.
 */
async function sendReply(
  to: string,
  text: string,
  accessToken: string,
  phoneNumberId: string,
): Promise<void> {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await sendText(to, chunk, accessToken, phoneNumberId);
  }
}

/**
 * Whether the inbound message is within Meta's 24h reply window.
 */
function withinReplyWindow(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return true; // no timestamp = assume in window
  return Date.now() / 1000 - ts <= REPLY_WINDOW_S;
}

/**
 * Creates the WhatsApp channel. Returns the deps object to pass to `handleWhatsAppWebhook`.
 *
 * @param agent - the REI agent instance (shared with the OpenAI-compatible handler).
 * @param workspacePath - the workspace the agent operates in.
 */
export function createWhatsAppChannel(
  agent: Agent,
  workspacePath: string,
): WhatsAppWebhookDeps {
  const channel = createPublicChannel(agent, workspacePath, "wa");
  const perMinute = turnsPerMinute();
  const rateCheck = createRateLimiter(perMinute);

  const handleInbound = async (msg: WhatsAppInbound): Promise<void> => {
    const from = msg.from;

    // Before anything that costs: a flood from one number must not become a flood of turns.
    const rate = rateCheck(from);
    if (!rate.allowed) {
      waLog(`✗ ignored ${msg.id} from ${maskNumber(from)}: rate limit (${perMinute}/min)`);
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
      if (rate.notify && accessToken && phoneNumberId) {
        await sendReply(
          from,
          "You're sending messages too fast for me to answer — please wait a minute and try again.",
          accessToken,
          phoneNumberId,
        );
      }
      return;
    }

    // Non-text: acknowledge but don't run the agent.
    if (msg.type !== "text") {
      waLog(`✗ ignored ${msg.id}: ${msg.type} message (only text is supported)`);
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
      if (accessToken && phoneNumberId) {
        await sendReply(
          from,
          "I can only process text messages for now. Please send a text message.",
          accessToken,
          phoneNumberId,
        );
      }
      return;
    }

    // Slash-commands: blocked. A phone user must not drive the agent's mode or run plans.
    if (isSlashCommand(msg.body)) {
      waLog(`✗ ignored ${msg.id}: slash command (blocked over WhatsApp)`);
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
      if (accessToken && phoneNumberId) {
        await sendReply(
          from,
          "Slash commands are not available over WhatsApp. Just type your question.",
          accessToken,
          phoneNumberId,
        );
      }
      return;
    }

    // 24h window: if the message is stale, Meta will reject the reply. Skip the agent.
    if (!withinReplyWindow(msg.timestamp)) {
      waLog(`✗ ignored ${msg.id} from ${maskNumber(from)}: outside the 24h reply window`);
      return;
    }

    await channel.enqueue(from, () => runTurn(channel, from, msg.body));
  };

  const onStatus = (status: WhatsAppStatus): void => {
    const who = maskNumber(status.recipientId);
    if (status.status === "failed") {
      const why = (status.errors ?? [])
        .map((e) => [e.code, e.title ?? e.message].filter(Boolean).join(" "))
        .join("; ");
      waError(`✗ delivery failed for ${who} (msg ${status.id}): ${why || "no reason given"}`);
      return;
    }
    waLog(`status ${status.status} for ${who} (msg ${status.id})`);
  };

  return { handleInbound, onStatus };
}

/**
 * Runs one agent turn for a WhatsApp message on the number's session, and sends the reply via the
 * Graph API.
 */
async function runTurn(channel: PublicChannel, from: string, prompt: string): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
  const who = maskNumber(from);
  const started = Date.now();
  waLog(`⟳ turn for ${who} started`);

  let response = "";
  try {
    response = await channel.turn(from, prompt);
  } catch (err) {
    // The 200 already went to Meta, so nobody else will report this: without the log it vanishes,
    // and without the reply the sender waits for an answer that is never coming.
    waError(`✗ turn for ${who} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (accessToken && phoneNumberId) {
      await sendReply(from, "Sorry, something went wrong on my side — please try again.", accessToken, phoneNumberId);
    }
    return;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  waLog(`✓ turn for ${who} done in ${seconds}s → reply ${response.trim().length} chars`);

  // Send the reply.
  if (!accessToken || !phoneNumberId) {
    waError("cannot reply: WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set");
    return;
  }
  if (!response.trim()) {
    await sendReply(from, "(no response)", accessToken, phoneNumberId);
    return;
  }
  await sendReply(from, response.trim(), accessToken, phoneNumberId);
}
