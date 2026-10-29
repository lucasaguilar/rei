/**
 * @fileoverview The web widget as a public channel: a visitor on a site writes, REI answers on the
 * visitor's own session, and the exchange is replicated to the conversation store — the same core
 * and policy as WhatsApp (public-channel.ts), only the transport differs (web-http.ts).
 *
 * The visitor is anonymous: the widget's `session_id` (kept in the browser) is the session key and,
 * as `web_<session_id>`, the contact key in the store. A new browser is a new visitor.
 *
 * @module rei/server/web-channel
 */
import type { Agent } from "../core/agent.js";
import { createBackendApi } from "./backend-api.js";
import { createChannelReplica, type ChannelReplica } from "./channel-replica.js";
import { createPublicChannel, isSlashCommand, type PublicChannel } from "./public-channel.js";
import { createRateLimiter } from "./whatsapp-limits.js";

export interface WebMessage {
  /** Validated by the transport: a plain token, safe as part of a file name. */
  sessionId: string;
  content: string;
  name?: string;
  /** The client address the rate limit is keyed on. */
  ip: string;
}

/** The shape the widget already reads from `/web/message`. */
export interface WebResult {
  status: number;
  body: { reply: string | null; status: "assistant" | "human" | "rate_limited" | "error" };
}

export interface WebChannel {
  /**
   * Answers one message. `onText` gets the reply's pieces as the model writes them (the streaming
   * transport); the result is the whole exchange either way, once it is recorded.
   */
  handleMessage(msg: WebMessage, onText?: (text: string) => void): Promise<WebResult>;
}

export interface WebLimits {
  perSession: number;
  /** Across sessions: a script can mint a new session id per message, an address it cannot. */
  perIp: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function webLimits(env: Record<string, string | undefined> = process.env): WebLimits {
  return {
    perSession: positiveInt(env.REI_WEB_RATE_PER_MIN, 10),
    perIp: positiveInt(env.REI_WEB_RATE_PER_MIN_IP, 30),
  };
}

export function webLog(line: string): void {
  console.log(`[web] ${line}`);
}

export function webError(line: string): void {
  console.error(`[web] ${line}`);
}

/** A session id is a bearer of the visitor's conversation: logs keep only its tail. */
export function maskSession(sessionId: string): string {
  return `web…${sessionId.slice(-4)}`;
}

export const TURN_FAILED_REPLY = "Sorry, something went wrong on my side — please try again.";

const contactKey = (sessionId: string) => `web_${sessionId}`;

/** The streamed text matches the trimmed reply: a model often opens with blank lines. */
function skipLeadingBlank(onText: (text: string) => void): (text: string) => void {
  let started = false;
  return (text) => {
    const piece = started ? text : text.trimStart();
    if (!piece) return;
    started = true;
    onText(piece);
  };
}

/** Wires the channel the server runs: its own sessions (`web-<session_id>.json`) and the replica. */
export function createWebChannelFor(agent: Agent, workspacePath: string): WebChannel {
  const replica = createChannelReplica(createBackendApi(), {
    channel: "web",
    maskKey: (key) => maskSession(key),
    logError: webError,
  });
  return createWebChannel(createPublicChannel(agent, workspacePath, "web", "plain"), replica);
}

export function createWebChannel(
  channel: PublicChannel,
  replica: ChannelReplica,
  limits: WebLimits = webLimits(),
): WebChannel {
  const perSession = createRateLimiter(limits.perSession);
  const perIp = createRateLimiter(limits.perIp);

  const answer = async (sessionId: string, reply: string): Promise<WebResult> => {
    await replica.recordReply(contactKey(sessionId), reply);
    return { status: 200, body: { reply, status: "assistant" } };
  };

  const handleAccepted = async (
    { sessionId, content, name }: WebMessage,
    onText?: (text: string) => void,
  ): Promise<WebResult> => {
    const who = maskSession(sessionId);
    const status = await replica.recordInbound({ key: contactKey(sessionId), content, name });

    if (status === "human") {
      webLog(`✗ not answering ${who}: an operator has this conversation`);
      return { status: 200, body: { reply: null, status: "human" } };
    }

    // `/mode agent`, `/runplan`… would bypass the ask-only policy.
    if (isSlashCommand(content)) {
      webLog(`✗ ignored message from ${who}: slash command`);
      return answer(sessionId, "Commands are not available here. Just type your question.");
    }

    const started = Date.now();
    let reply: string;
    try {
      reply = (await channel.turn(sessionId, content, onText && skipLeadingBlank(onText))).trim() || "(no response)";
    } catch (err) {
      webError(`✗ turn for ${who} failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        status: 502,
        body: { reply: TURN_FAILED_REPLY, status: "error" },
      };
    }
    webLog(`✓ turn for ${who} done in ${((Date.now() - started) / 1000).toFixed(1)}s → reply ${reply.length} chars`);
    return answer(sessionId, reply);
  };

  return {
    async handleMessage(msg, onText) {
      // Before anything that costs: a turn, a replica row, provider tokens.
      if (!perIp(msg.ip).allowed || !perSession(msg.sessionId).allowed) {
        webLog(`✗ ignored message from ${maskSession(msg.sessionId)}: rate limit`);
        return {
          status: 429,
          body: {
            reply: "You're sending messages too fast for me to answer — please wait a minute and try again.",
            status: "rate_limited",
          },
        };
      }

      // The response waits for the turn, so the visitor's queue holds the whole exchange: two
      // messages from one browser answer in order, and a takeover is read when this one is due.
      let result: WebResult | undefined;
      await channel.enqueue(msg.sessionId, async () => {
        result = await handleAccepted(msg, onText);
      });
      return result!;
    },
  };
}
