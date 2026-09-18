import { describe, it, expect } from "vitest";
import { mergeTurnUsage } from "./token-usage.js";

/**
 * A turn makes one model call per tool iteration, and the gauge reads one number out of all of
 * them. The peak answers "how big did the prompt get"; the LAST call answers "how big is the
 * context now" — and the two stop agreeing the moment the turn compacts. The bar needs the second:
 * with only the peak, a compaction at 60k left it reading 60k while the real history was half that.
 */
describe("mergeTurnUsage across a turn that compacts", () => {
  it("keeps the peak and the current reading apart once the history shrinks", () => {
    let usage = mergeTurnUsage(undefined, { promptTokens: 42_000, completionTokens: 100 });
    usage = mergeTurnUsage(usage, { promptTokens: 60_000, completionTokens: 150 });
    // …compaction here: every later call sends a much smaller prompt.
    usage = mergeTurnUsage(usage, { promptTokens: 24_000, completionTokens: 200 });

    expect(usage.promptTokens).toBe(60_000); // the peak, for "tok in"
    expect(usage.lastPromptTokens).toBe(24_000); // what the bar must show
    expect(usage.completionTokens).toBe(450); // output still sums
  });

  it("agrees with the peak on a turn that only grows", () => {
    let usage = mergeTurnUsage(undefined, { promptTokens: 8_000 });
    usage = mergeTurnUsage(usage, { promptTokens: 9_500 });
    expect(usage.lastPromptTokens).toBe(usage.promptTokens);
  });

  it("holds the last reading when a call reports no prompt count", () => {
    let usage = mergeTurnUsage(undefined, { promptTokens: 30_000 });
    usage = mergeTurnUsage(usage, { completionTokens: 12 });
    // Not 0: one silent response must not read as an emptied context.
    expect(usage.lastPromptTokens).toBe(30_000);
  });
});
