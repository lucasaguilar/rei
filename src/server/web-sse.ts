/**
 * @fileoverview The web widget's streamed reply (`POST /channels/web/stream`), as Server-Sent
 * Events in the format the widget already reads:
 *
 *     data: {"conversation_id":"…","status":"assistant"|"human"}
 *     data: {"chunk":"…"}            (zero or more)
 *     data: [DONE]
 *
 * Every outcome ends that way, with status 200 — a refusal, a rate limit or a failed turn included,
 * as a chunk of text. The widget answers a failed response or an `{ error }` event by sending the
 * same message again over `/message`, which would record it twice and run the turn twice.
 *
 * The request is validated before this runs (web-http.ts); here the response is already committed.
 *
 * @module rei/server/web-sse
 */
import type { ServerResponse } from "node:http";
import { TURN_FAILED_REPLY, webError, type WebChannel, type WebMessage } from "./web-channel.js";

/** Under the idle timeout of common proxies; a local model can think for longer than that. */
const HEARTBEAT_MS = 15_000;

export interface StreamOptions {
  heartbeatMs?: number;
}

export async function streamWebReply(
  res: ServerResponse,
  channel: WebChannel,
  msg: WebMessage,
  { heartbeatMs = HEARTBEAT_MS }: StreamOptions = {},
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Some proxies buffer a response until it ends, which would turn the stream back into a wait.
    "X-Accel-Buffering": "no",
  });

  // A visitor who closes the tab ends the response, not the turn: it finishes and is recorded.
  const write = (line: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(line);
  };
  const event = (data: unknown) => write(`data: ${JSON.stringify(data)}\n\n`);
  // Comment lines: the widget skips anything that is not `data: `.
  const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
  res.on("close", () => clearInterval(heartbeat));

  // The widget reads the status from the first event only, and only if it names a conversation.
  // The visitor's conversation, to REI, is their session; the store's ids stay in the store.
  let started = false;
  const start = (status: "assistant" | "human") => {
    if (started) return;
    started = true;
    event({ conversation_id: msg.sessionId, status });
  };

  try {
    let streamed = false;
    const result = await channel.handleMessage(msg, (text) => {
      start("assistant");
      streamed = true;
      event({ chunk: text });
    });
    const { reply, status } = result.body;
    start(status === "human" ? "human" : "assistant");
    if (reply && !streamed) event({ chunk: reply });
    else if (reply && status === "error") event({ chunk: `\n\n${reply}` });
  } catch (err) {
    webError(`✗ stream failed: ${err instanceof Error ? err.message : String(err)}`);
    start("assistant");
    event({ chunk: TURN_FAILED_REPLY });
  } finally {
    clearInterval(heartbeat);
    write("data: [DONE]\n\n");
    if (!res.writableEnded) res.end();
  }
}
