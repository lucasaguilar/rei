import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS script shipped standalone to ~/.rei/scripts, no .d.ts by design.
import { describeProbeError } from "../../scripts/launch-rei.js";

/**
 * The endpoint probe used to swallow every failure in a bare `catch {}`, so "LM Studio is off",
 * "macOS blocked Node from the LAN" and "the server took longer than 4s" all rendered as the same
 * "Could not reach …". A user whose curl worked could not tell which one they had.
 */
const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

describe("describeProbeError", () => {
  it("names a timeout as a timeout", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeProbeError(err)).toMatch(/timed out after 4s/);
  });

  it("names a refused connection and points at the server", () => {
    expect(describeProbeError(fetchFailed("ECONNREFUSED"))).toMatch(/ECONNREFUSED.*server not running/);
  });

  it("points an unreachable host at macOS Local Network permission", () => {
    expect(describeProbeError(fetchFailed("EHOSTUNREACH"))).toMatch(/EHOSTUNREACH.*Local Network/);
  });

  it("names an unknown hostname", () => {
    expect(describeProbeError(fetchFailed("ENOTFOUND"))).toMatch(/ENOTFOUND.*hostname/);
  });

  it("still reports the code of an error it has no hint for", () => {
    expect(describeProbeError(fetchFailed("ECONNRESET"))).toContain("ECONNRESET");
  });

  it("falls back to the message when there is no code", () => {
    expect(describeProbeError(new Error("Invalid URL"))).toContain("Invalid URL");
  });
});

describe("describeProbeError without a code", () => {
  it("prefers the cause over fetch's generic message", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
    expect(describeProbeError(err)).toBe("bad port");
  });
});
