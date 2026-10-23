import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describeWebChannel, handleWebChannelRequest, isWebChannelRequest } from "./web-http.js";
import type { WebChannel, WebMessage } from "./web-channel.js";

/**
 * The widget's transport. The endpoint is public by nature (the page runs in a stranger's
 * browser), so it is gated by what a public client can carry: the site's public key, an allowed
 * Origin, a validated session id and bounded input. It speaks the protocol the widget already
 * uses: `POST …/web/message` with `{ session_id, content, name? }` → `{ reply, status }`.
 */

const SITE_KEY = "pk_test_0000000000000000";
const ORIGIN = "https://shop.example";
const SESSION = "3f2b9c1e-0000-4000-8000-000000000001";
const ENV = { REI_WEB_SITE_KEY: SITE_KEY, REI_WEB_ALLOWED_ORIGINS: `${ORIGIN}, https://www.shop.example` };

let server: http.Server;
let base: string;
let received: WebMessage[];
let env: Record<string, string | undefined>;

beforeEach(async () => {
  received = [];
  env = { ...ENV };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const channel: WebChannel = {
    handleMessage: async (m) => {
      received.push(m);
      return { status: 200, body: { reply: "¡Hola!", status: "assistant" } };
    },
  };
  server = http.createServer((req, res) => void handleWebChannelRequest(req, res, channel, env));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/channels/web/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Authorization: `Bearer ${SITE_KEY}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("isWebChannelRequest", () => {
  it("is off without REI_WEB_SITE_KEY, so the route does not exist", () => {
    expect(isWebChannelRequest("/channels/web/message", {})).toBe(false);
    expect(isWebChannelRequest("/channels/web/message", ENV)).toBe(true);
    expect(isWebChannelRequest("/v1/channels/web/message?x=1", ENV)).toBe(true);
    expect(isWebChannelRequest("/chat/completions", ENV)).toBe(false);
  });
});

describe("describeWebChannel", () => {
  // The startup banner said "a page cannot call this server" while the widget route was open — true
  // of the owner's endpoint only, and misleading the first time the widget is tried.
  it("names the route and its origins when the channel is on, and nothing when it is off", () => {
    expect(describeWebChannel({})).toBeNull();
    const line = describeWebChannel(ENV)!;
    expect(line).toContain("/channels/web/message");
    expect(line).toContain(ORIGIN);
    expect(line).not.toContain(SITE_KEY);
  });

  it("warns when no origin is allowed, since every browser request would then be refused", () => {
    expect(describeWebChannel({ REI_WEB_SITE_KEY: SITE_KEY })).toMatch(/REI_WEB_ALLOWED_ORIGINS/);
  });
});

describe("handleWebChannelRequest", () => {
  it("answers a valid message and hands the channel the session, text, name and client IP", async () => {
    const res = await post({ session_id: SESSION, content: "hola", name: "Ana" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "¡Hola!", status: "assistant" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(received).toEqual([{ sessionId: SESSION, content: "hola", name: "Ana", ip: "127.0.0.1" }]);
  });

  it("accepts the site key in X-Rei-Site-Key too", async () => {
    const res = await post({ session_id: SESSION, content: "hola" }, { Authorization: "", "X-Rei-Site-Key": SITE_KEY });
    expect(res.status).toBe(200);
  });

  it("answers the preflight of an allowed origin, and refuses any other origin", async () => {
    const ok = await fetch(`${base}/channels/web/message`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-headers")).toMatch(/authorization/i);

    const other = await post({ session_id: SESSION, content: "hola" }, { Origin: "https://evil.example" });
    expect(other.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses a wrong or missing site key", async () => {
    expect((await post({ session_id: SESSION, content: "hola" }, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ session_id: SESSION, content: "hola" }, { Authorization: "" })).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("refuses a session id that is not a plain token — it names a file on disk", async () => {
    for (const session_id of ["../../etc/passwd", "a b", "", "x".repeat(65), 42]) {
      expect((await post({ session_id, content: "hola" })).status).toBe(400);
    }
    expect(received).toHaveLength(0);
  });

  it("refuses empty or oversized content, a bad name, and a body that is not JSON", async () => {
    expect((await post({ session_id: SESSION, content: "   " })).status).toBe(400);
    expect((await post({ session_id: SESSION, content: "x".repeat(4001) })).status).toBe(400);
    expect((await post({ session_id: SESSION, content: "hola", name: "x".repeat(61) })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("refuses a body too large to be a chat message before reading it all", async () => {
    const res = await post({ session_id: SESSION, content: "x".repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it("behind a trusted proxy, limits by the address the proxy saw, not one the client wrote", async () => {
    env.REI_TRUST_PROXY = "true";
    // A client can send its own X-Forwarded-For; the proxy appends the real address last.
    await post({ session_id: SESSION, content: "hola" }, { "X-Forwarded-For": "1.2.3.4, 198.51.100.9" });
    expect(received[0].ip).toBe("198.51.100.9");
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    await post({ session_id: SESSION, content: "hola" }, { "X-Forwarded-For": "1.2.3.4" });
    expect(received[0].ip).toBe("127.0.0.1");
  });

  it("streams over /channels/web/stream, behind the same gates as /message", async () => {
    const stream = (headers: Record<string, string>, body: unknown = { session_id: SESSION, content: "hola" }) =>
      fetch(`${base}/channels/web/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      });

    expect((await stream({ Authorization: "Bearer nope" })).status).toBe(401);
    expect((await stream({ Authorization: `Bearer ${SITE_KEY}`, Origin: "https://evil.example" })).status).toBe(403);
    expect((await stream({ Authorization: `Bearer ${SITE_KEY}` }, { session_id: "../x", content: "hola" })).status).toBe(400);
    expect(received).toHaveLength(0);

    const res = await stream({ Authorization: `Bearer ${SITE_KEY}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await res.text()).toContain('data: {"chunk":"¡Hola!"}');
    expect(received).toHaveLength(1);
  });

  it("answers any other path with 404", async () => {
    const res = await fetch(`${base}/channels/web/other`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${SITE_KEY}` },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
