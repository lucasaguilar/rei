import { describe, it, expect, vi } from "vitest";
import { buildMismatchEscalationMessage } from "./mismatch-escalation.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;
const ctx = {
  logger: fakeLogger,
  emitStatus: () => {},
  currentContent: async (f: string) => `CONTENT OF ${f}`,
};

describe("buildMismatchEscalationMessage", () => {
  it("inject tier: includes the exact current content of the file(s)", async () => {
    const msg = await buildMismatchEscalationMessage(
      { files: ["a.ts"], mode: "inject" },
      ctx,
    );
    expect(msg).toContain("did NOT match");
    expect(msg).toContain("CONTENT OF a.ts");
    expect(msg).toContain("VERBATIM");
  });

  it("wholefile tier: tells the model to switch to rewrite_file", async () => {
    const msg = await buildMismatchEscalationMessage(
      { files: ["a.ts", "b.ts"], mode: "wholefile" },
      ctx,
    );
    expect(msg).toContain("STOP using edit_file");
    expect(msg).toContain("rewrite_file");
    expect(msg).toContain("a.ts, b.ts");
    // wholefile tier does not re-dump file content
    expect(msg).not.toContain("CONTENT OF");
  });
});
