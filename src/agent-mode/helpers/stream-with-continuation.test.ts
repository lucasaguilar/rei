import { describe, it, expect, vi, beforeEach } from "vitest";

const { streamTurnWithInterception } = vi.hoisted(() => ({
  streamTurnWithInterception: vi.fn(),
}));
vi.mock("./token-streamer.js", () => ({ streamTurnWithInterception }));

import {
  streamWithContinuation,
  MAX_TRUNCATION_CONTINUATIONS,
} from "./stream-with-continuation.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

/** Queues one streamTurnWithInterception result: returns `text`, reports `finish` via onFinish. */
function reply(text: string, finish: string) {
  streamTurnWithInterception.mockImplementationOnce(
    async (p: { onFinish?: (r: string) => void }) => {
      p.onFinish?.(finish);
      return text;
    },
  );
}

const base = {
  provider: {} as never,
  messages: [{ role: "user" as const, content: "go" }],
  modelOverride: undefined,
  logger: fakeLogger,
};

describe("streamWithContinuation", () => {
  beforeEach(() => streamTurnWithInterception.mockReset());

  it("returns the response unchanged when the model finishes normally", async () => {
    reply("all done", "stop");
    const out = await streamWithContinuation({ ...base, truncationCount: 0 });
    expect(out.rawResponse).toBe("all done");
    expect(out.truncationCount).toBe(0);
    expect(streamTurnWithInterception).toHaveBeenCalledTimes(1);
  });

  it("auto-continues on truncation and joins the parts", async () => {
    reply("part1", "length");
    reply("part2", "stop");
    const out = await streamWithContinuation({ ...base, truncationCount: 0 });
    expect(out.rawResponse).toBe("part1part2");
    expect(out.truncationCount).toBe(1);
    expect(streamTurnWithInterception).toHaveBeenCalledTimes(2);
  });

  it("stops continuing once the running truncation budget is exhausted", async () => {
    reply("x", "length"); // would continue, but budget is already spent
    const out = await streamWithContinuation({
      ...base,
      truncationCount: MAX_TRUNCATION_CONTINUATIONS,
    });
    expect(out.rawResponse).toBe("x");
    expect(out.truncationCount).toBe(MAX_TRUNCATION_CONTINUATIONS);
    expect(streamTurnWithInterception).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the caller's messages array across continuations", async () => {
    reply("a", "length");
    reply("b", "stop");
    const messages = [{ role: "user" as const, content: "go" }];
    await streamWithContinuation({ ...base, messages, truncationCount: 0 });
    expect(messages).toEqual([{ role: "user", content: "go" }]);
  });
});
