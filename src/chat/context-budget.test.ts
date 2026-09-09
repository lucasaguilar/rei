import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildMessagesForModel } from "./message-builder.js";
import { needsCompaction } from "./compactor.js";
import { estimateMessagesTokens } from "./helpers/token-estimator.js";
import type { ChatMessage } from "./types.js";

/**
 * The budget has to pay for everything the request carries.
 *
 * It used to govern the history alone: the system prompt (~3.3k tokens) and the tools schema
 * (~2.3k) were counted by nobody, and the latest message was kept WHOLE at any size. In agent mode
 * every tool result is a message, so one `read_files` of a large file sailed through — 37,472
 * tokens sent against a 32,768 window, with the trimmer reporting itself within budget.
 */
const SYSTEM_TOKENS = 3297;
const TOOLS_TOKENS = 2321;
const sys = (): ChatMessage => ({ role: "system", content: "S".repeat(SYSTEM_TOKENS * 4) });
const huge = (): ChatMessage => ({ role: "user", content: "X".repeat(120_000) });
const history = (n: number): ChatMessage[] =>
  Array.from({ length: n }, () => ({ role: "assistant", content: "h".repeat(4000) }) as ChatMessage);

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {
    w: process.env.REI_CONTEXT_WINDOW,
    o: process.env.REI_MAX_OUTPUT_TOKENS,
  };
  process.env.REI_CONTEXT_WINDOW = "32768";
  process.env.REI_MAX_OUTPUT_TOKENS = "4096";
});
afterEach(() => {
  if (saved.w === undefined) delete process.env.REI_CONTEXT_WINDOW;
  else process.env.REI_CONTEXT_WINDOW = saved.w;
  if (saved.o === undefined) delete process.env.REI_MAX_OUTPUT_TOKENS;
  else process.env.REI_MAX_OUTPUT_TOKENS = saved.o;
});

describe("the whole request fits the window", () => {
  it("stays under the window with a huge latest message", () => {
    const out = buildMessagesForModel([sys(), ...history(20), huge()], "agent", undefined, TOOLS_TOKENS);
    expect(estimateMessagesTokens(out) + TOOLS_TOKENS).toBeLessThanOrEqual(32768);
  });

  it("counts the tools schema: the same input yields a smaller result when it is declared", () => {
    const without = buildMessagesForModel([sys(), ...history(20), huge()], "agent", undefined, 0);
    const with_ = buildMessagesForModel([sys(), ...history(20), huge()], "agent", undefined, TOOLS_TOKENS);
    expect(estimateMessagesTokens(with_)).toBeLessThan(estimateMessagesTokens(without));
  });

  it("clamps the latest message instead of passing it through whole", () => {
    const out = buildMessagesForModel([sys(), huge()], "agent", undefined, TOOLS_TOKENS);
    const last = out[out.length - 1];
    expect(last.content.length).toBeLessThan(120_000);
    expect(last.content).toContain("trimmed to fit the context window");
  });

  it("keeps the head AND the tail of what it clamps", () => {
    // The imports are at the top of a file and the error at the bottom of a log; a head-only cut
    // loses whichever half mattered.
    const msg: ChatMessage = { role: "user", content: "HEAD" + "x".repeat(200_000) + "TAIL" };
    const out = buildMessagesForModel([sys(), msg], "agent", undefined, TOOLS_TOKENS);
    const last = out[out.length - 1];
    expect(last.content.startsWith("HEAD")).toBe(true);
    expect(last.content.endsWith("TAIL")).toBe(true);
  });

  it("leaves a message that already fits untouched", () => {
    const small: ChatMessage = { role: "user", content: "just a question" };
    const out = buildMessagesForModel([sys(), small], "agent", undefined, TOOLS_TOKENS);
    expect(out[out.length - 1].content).toBe("just a question");
  });
});

describe("compaction counts the same overhead", () => {
  it("triggers earlier once the fixed cost is declared", () => {
    // It used to wait for a threshold the request had already blown past, because only the
    // messages were weighed.
    const msgs = [sys(), ...history(12)];
    const withoutOverhead = needsCompaction(msgs, 0);
    const withOverhead = needsCompaction(msgs, SYSTEM_TOKENS + TOOLS_TOKENS);
    expect(withOverhead || !withoutOverhead).toBe(true); // never LESS eager than before
  });

  it("does not compact a short conversation whatever the overhead", () => {
    expect(needsCompaction([sys(), history(1)[0]], 10_000)).toBe(false);
  });
});
