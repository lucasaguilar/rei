/**
 * @fileoverview The WhatsApp channel — bridges the webhook (inbound) to the agent (turn) and the
 * Graph API (outbound). One channel instance per server; it manages per-number sessions,
 * serializes turns per number, and sends replies via the WhatsApp Graph API.
 *
 * Design constraints:
 *  - Mode is forced to `ask` (read-only): a phone user should not be able to make the agent
 *    edit files or run commands.
 *  - Slash-commands are blocked: `/runplan`, `/mode agent`, etc. would bypass the ask-only guard.
 *  - 24h window: Meta only allows replies within 24h of the last inbound; after that the send
 *    would 403, so we skip the agent entirely.
 *  - 4096-char chunking: the Graph API caps text messages at 4096 chars; longer replies are split.
 *
 * @module rei/server/whatsapp-channel
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Agent } from "../core/agent.js";
import type { ChatSession, ChatMessage, SessionMode } from "../chat/types.js";
import { loadSessionById, sessionsDir } from "../chat/session-store.js";
import type { WhatsAppInbound, WhatsAppStatus, WhatsAppWebhookDeps } from "./whatsapp-webhook.js";
import { waLog, waError, maskNumber } from "./whatsapp-log.js";

/** WhatsApp Graph API text message limit. */
const MAX_MESSAGE_CHARS = 4096;

/** 24 hours in seconds — Meta's reply window. */
const REPLY_WINDOW_S = 24 * 3600;

/** The Graph API base URL (version pinned; bump when Meta deprecates). */
const GRAPH_BASE = "https://graph.facebook.com/v25.0";

/**
 * A per-number session, keyed by the sender's phone number. The session id is `wa-<from>` so it
 * never collides with CLI sessions (which use timestamped or named ids).
 */
function sessionIdFor(from: string): string {
  return `wa-${from}`;
}

/**
 * Loads (or creates) the session for a given number. Always forces mode to `ask` — a phone user
 * must not be able to switch to agent/planning mode via a message.
 */
function loadOrCreateSession(workspacePath: string, from: string): ChatSession {
  const id = sessionIdFor(from);
  const existing = loadSessionById(workspacePath, id);
  if (existing) {
    return {
      messages: existing.messages,
      mode: "ask" as SessionMode, // always ask, regardless of what was persisted
      createdAt: existing.createdAt,
      summary: existing.summary,
    };
  }
  return { messages: [], mode: "ask" as SessionMode };
}

/** Persists a session to its per-number file. */
function persistSession(
  workspacePath: string,
  from: string,
  session: ChatSession,
): void {
  const dir = sessionsDir(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const data = {
    version: 1,
    workspace: workspacePath,
    mode: session.mode,
    createdAt: session.createdAt ?? now,
    updatedAt: now,
    summary: session.summary,
    messages: session.messages,
  };
  fs.writeFileSync(
    path.join(dir, `${sessionIdFor(from)}.json`),
    JSON.stringify(data, null, 2),
    "utf8",
  );
}

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
      to,
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
 * Whether the prompt is a slash-command (starts with `/`). These are blocked: a phone user
 * should not be able to invoke `/mode agent`, `/runplan`, etc.
 */
function isSlashCommand(body: string): boolean {
  return body.trimStart().startsWith("/");
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
  /** Per-number serialization: one turn at a time per sender. */
  const queues = new Map<string, Promise<void>>();

  const handleInbound = async (msg: WhatsAppInbound): Promise<void> => {
    const from = msg.from;

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

    // Serialize per number: chain onto the previous turn for this sender.
    const prev = queues.get(from) ?? Promise.resolve();
    const current = prev.then(() => runTurn(agent, workspacePath, from, msg.body));
    queues.set(from, current.catch(() => {})); // don't let a failure block the next
    await current;
  };

  const onStatus = (status: WhatsAppStatus): void => {
    waLog(`status ${status.status} for ${maskNumber(status.recipientId)} (msg ${status.id})`);
  };

  return { handleInbound, onStatus };
}

/**
 * Runs one agent turn for a WhatsApp message: loads the per-number session, streams the turn,
 * collects the response, persists the session, and sends the reply via the Graph API.
 */
async function runTurn(
  agent: Agent,
  workspacePath: string,
  from: string,
  prompt: string,
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
  const who = maskNumber(from);
  const started = Date.now();
  waLog(`⟳ turn for ${who} started`);

  let response = "";
  try {
    const session = loadOrCreateSession(workspacePath, from);
    for await (const chunk of agent.streamTurn(session, prompt, { onStatus: () => {} })) {
      if (chunk.startsWith("\x11")) {
        response += chunk.slice(1);
      }
    }
    // Persist the session (streamTurn already pushed user + assistant messages).
    persistSession(workspacePath, from, session);
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
