import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The web channel's route is public and has its own gates (web-http.ts), so server.ts must let it
 * past the two owner-only gates — the browser-origin guard (a widget IS a browser on another
 * origin) and the bearer token (a widget cannot hold one) — and must build the channel once, or
 * its per-session queue and rate limits hold nothing (the bug whatsapp-wiring.regression.test.ts
 * pins for WhatsApp).
 *
 * server.ts is a startup script (top-level await, process.exit), so the wiring is checked on its
 * source, as the WhatsApp wiring test does.
 */
describe("server.ts wires the web channel", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../server.ts"), "utf8");

  it("builds the channel once, before the request handler", () => {
    expect(source.match(/createWebChannelFor\(/g) ?? []).toHaveLength(1);
    expect(source.indexOf("createWebChannelFor(")).toBeLessThan(source.indexOf("http.createServer("));
  });

  it("exempts the route from the browser-origin guard", () => {
    const guard = source.slice(source.indexOf("browserRejection &&"), source.indexOf("res.writeHead(browserRejection.status"));
    expect(guard).toContain("isWebChannelRequest(");
  });

  it("routes it before the bearer-token check", () => {
    const route = source.indexOf("handleWebChannelRequest(");
    expect(route).toBeGreaterThan(-1);
    expect(route).toBeLessThan(source.indexOf("if (AUTH_TOKEN) {"));
  });
});
