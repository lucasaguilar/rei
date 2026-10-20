import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Regression: server.ts built the WhatsApp channel INSIDE the request callback, so every webhook got
 * a fresh one. The per-number queue, the concurrency semaphore and the per-minute rate limiter all
 * live in that object, so in production none of them held across messages: two messages from one
 * customer ran concurrently on the same session file, and the rate limit never tripped. The channel
 * tests could not see it — they build one channel and reuse it, which is exactly what production
 * did not do.
 *
 * server.ts is a startup script (top-level await, process.exit), so it cannot be imported here; the
 * wiring is checked on its source, as shell-escape.test.ts does for the same file.
 */
describe("server.ts wires ONE WhatsApp channel for the process", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../server.ts"), "utf8");

  it("builds the channel once, before the request handler", () => {
    const builds = source.match(/createWhatsAppChannel\(/g) ?? [];
    expect(builds).toHaveLength(1);
    expect(source.indexOf("createWhatsAppChannel(")).toBeLessThan(
      source.indexOf("http.createServer("),
    );
  });
});
