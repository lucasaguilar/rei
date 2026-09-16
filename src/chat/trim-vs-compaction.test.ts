import { describe, it, expect, afterEach } from "vitest";
import { buildMessagesForModel } from "./message-builder.js";
import { needsCompaction } from "./compactor.js";
import type { ChatMessage } from "./types.js";

/**
 * Two mechanisms shrink a conversation, and only one of them is safe.
 *
 * COMPACTION replaces old messages with a summary, once, when the history crosses a threshold. It
 * costs a cold prefill on that turn and then leaves the history alone — the backend re-caches the
 * new prefix and every following turn is cheap again.
 *
 * The BUDGET TRIM inside buildMessagesForModel drops the oldest messages to fit a token budget.
 * Because the history keeps growing, its cut point advances a little every turn, so it rewrites
 * what the model sees on EVERY turn. A local runtime reuses its KV cache only while each prompt
 * extends the last, so that is a full re-prefill per turn — 40s and up on a real session.
 *
 * Today compaction always fires first, but only because 0.65 happens to be below 0.85. Nothing
 * protected that. This does: move either constant the wrong way and these fail, instead of the
 * session quietly paying a re-prefill per turn that nobody can explain.
 */
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const OVERHEAD = 2000; // system prompt + tools schema, counted by both sides
const FIRST_MARKER = "PRIMER-MENSAJE-DE-LA-CONVERSACION";

/** ~500 tokens of filler per call, at the usual 4 chars/token estimate. */
const chunk = (i: number) => `turno ${i}: ` + "palabra ".repeat(250);

function historyOf(turns: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: `${FIRST_MARKER} ${chunk(0)}` },
  ];
  for (let i = 1; i <= turns; i++) {
    msgs.push({ role: "assistant", content: chunk(i) });
    msgs.push({ role: "user", content: chunk(i) });
  }
  return msgs;
}

/** True once the builder has started dropping the oldest history. */
function trimmed(msgs: ChatMessage[]): boolean {
  const out = buildMessagesForModel(msgs, "agent", undefined, OVERHEAD);
  return !out.some((m) => m.content.includes(FIRST_MARKER));
}

describe("compaction always fires before the budget trim", () => {
  it.each([
    [200000, 16384],
    [131072, 16384],
    [65536, 8192],
    [50176, 9500],
  ])("window %i / output %i", (window, output) => {
    process.env.REI_CONTEXT_WINDOW = String(window);
    process.env.REI_MAX_OUTPUT_TOKENS = String(output);

    // Grow the conversation until the builder drops the oldest message.
    let turns = 4;
    let msgs = historyOf(turns);
    while (!trimmed(msgs) && turns < 4000) {
      turns = Math.ceil(turns * 1.5);
      msgs = historyOf(turns);
    }
    expect(trimmed(msgs), "the trim never engaged — widen the search").toBe(true);

    // By the time it does, compaction must already have been due: it is the mechanism that is
    // allowed to rewrite history, because it does so once instead of on every turn.
    expect(needsCompaction(msgs, OVERHEAD)).toBe(true);
  });

  it("is still true with no output reserve configured", () => {
    process.env.REI_CONTEXT_WINDOW = "32768";
    delete process.env.REI_MAX_OUTPUT_TOKENS;
    let turns = 4;
    let msgs = historyOf(turns);
    while (!trimmed(msgs) && turns < 4000) {
      turns = Math.ceil(turns * 1.5);
      msgs = historyOf(turns);
    }
    expect(needsCompaction(msgs, OVERHEAD)).toBe(true);
  });
});
