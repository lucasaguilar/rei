import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { streamWebReply } from "./web-sse.js";
import type { WebChannel, WebMessage, WebResult } from "./web-channel.js";

/**
 * The streamed reply, in the format the widget already reads from `…/web/stream`: a first event
 * `{ conversation_id, status }`, then `{ chunk }` events, then `[DONE]`. Every outcome ends that
 * way: the widget answers an `{ error }` event — or a failed response — by sending the message
 * again over `/message`, which would run the visitor's turn twice.
 */

const SESSION = "3f2b9c1e-0000-4000-8000-000000000001";
const MESSAGE: WebMessage = { sessionId: SESSION, content: "hola", ip: "127.0.0.1" };

let server: http.Server;
let base: string;
let channel: WebChannel;
let heartbeatMs: number;

beforeEach(async () => {
  heartbeatMs = 15_000;
  vi.spyOn(console, "error").mockImplementation(() => {});
  server = http.createServer((_req, res) => void streamWebReply(res, channel, MESSAGE, { heartbeatMs }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A channel that streams `pieces`, then resolves with `result`. */
function channelThat(pieces: string[], result: WebResult["body"], status = 200): WebChannel {
  return {
    handleMessage: async (_m, onText) => {
      for (const p of pieces) onText?.(p);
      return { status, body: result };
    },
  };
}

async function read(): Promise<{ res: Response; raw: string; events: unknown[] }> {
  const res = await fetch(base);
  const raw = await res.text();
  const events = raw
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .map((d) => (d === "[DONE]" ? d : JSON.parse(d)));
  return { res, raw, events };
}

describe("streamWebReply", () => {
  it("streams the reply as it is written: status first, then chunks, then [DONE]", async () => {
    channel = channelThat(["¡Ho", "la!"], { reply: "¡Hola!", status: "assistant" });

    const { res, events } = await read();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(events).toEqual([
      { conversation_id: SESSION, status: "assistant" },
      { chunk: "¡Ho" },
      { chunk: "la!" },
      "[DONE]",
    ]);
  });

  it("says an operator has the conversation, with no chunk", async () => {
    channel = channelThat([], { reply: null, status: "human" });

    expect((await read()).events).toEqual([{ conversation_id: SESSION, status: "human" }, "[DONE]"]);
  });

  it("sends an answer that was not streamed (a refusal, a rate limit) as one chunk, never as an error", async () => {
    channel = channelThat([], { reply: "Too fast — wait a minute.", status: "rate_limited" }, 429);

    const { res, events } = await read();

    expect(res.status).toBe(200);
    expect(events).toEqual([
      { conversation_id: SESSION, status: "assistant" },
      { chunk: "Too fast — wait a minute." },
      "[DONE]",
    ]);
  });

  it("appends the apology to a reply that failed halfway, instead of an error event", async () => {
    channel = channelThat(["Our hours are"], { reply: "Sorry, something went wrong.", status: "error" }, 502);

    const { events } = await read();

    expect(events).toEqual([
      { conversation_id: SESSION, status: "assistant" },
      { chunk: "Our hours are" },
      { chunk: "\n\nSorry, something went wrong." },
      "[DONE]",
    ]);
  });

  it("still closes the stream with an apology when the channel throws", async () => {
    channel = { handleMessage: async () => Promise.reject(new Error("boom")) };

    const { events } = await read();

    expect(events[0]).toEqual({ conversation_id: SESSION, status: "assistant" });
    expect(events[1]).toEqual({ chunk: expect.stringMatching(/something went wrong/i) });
    expect(events.at(-1)).toBe("[DONE]");
  });

  it("keeps the connection alive while the model thinks, with comments the widget skips", async () => {
    // A proxy drops a response that stays silent too long; a local model can think for a minute.
    heartbeatMs = 10;
    channel = {
      handleMessage: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { status: 200, body: { reply: "ok", status: "assistant" } };
      },
    };

    const { raw, events } = await read();

    expect(raw).toMatch(/^: /m);
    expect(events.at(-1)).toBe("[DONE]");
  });
});
