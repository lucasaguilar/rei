import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../chat/session-store.js", () => ({ saveSession: vi.fn() }));
vi.mock("../vision-sidecar.js", () => ({ describeAttachedImages: vi.fn(async () => null) }));

import { handleInputTurn } from "./input-turn.helpers.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";
import type { ChatMessage } from "../../chat/types.js";

/**
 * The sticky context bar after a compaction.
 *
 * The bar is published at the END of a turn — deliberately, since re-estimating the whole history
 * on every keystroke would put a token count in the input loop. But an agent turn compacts at its
 * START and then runs for minutes: the history was cut in half and the bar went on showing the
 * figure measured before the cut, so the compaction you just watched happen changed nothing on
 * screen. The agent now emits `memory_compacted` and the turn re-measures on the spot.
 */
const savedWindow = process.env.REI_CONTEXT_WINDOW;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.REI_CONTEXT_WINDOW = "100000";
});
afterEach(() => {
  if (savedWindow === undefined) delete process.env.REI_CONTEXT_WINDOW;
  else process.env.REI_CONTEXT_WINDOW = savedWindow;
});

/** A history of roughly `tokens` tokens, at the chars/4 the estimate assumes. */
const historyOf = (tokens: number): ChatMessage[] => [
  { role: "user", content: "x".repeat(tokens * 4) } as ChatMessage,
];

async function runTurnThatCompacts(opts: { compact: boolean }) {
  const session = { messages: historyOf(60_000), mode: "agent" } as unknown as {
    messages: ChatMessage[];
    mode: string;
  };
  /** state.contextTokens at each draw, with "END" marking where the stream finished — so a reading
   *  taken DURING the turn is told apart from the end-of-turn one that always happens. */
  const readings: (number | undefined | "END")[] = [];
  const state: Record<string, unknown> = {};

  const ctx = {
    state,
    session,
    transcript: [],
    workspacePath: "/tmp",
    agent: {
      async *streamTurn(
        _session: unknown,
        _prompt: string,
        options: { onStatus?: (s: string) => void },
      ) {
        options.onStatus?.("calling_model");
        yield "\x11trabajando";
        if (opts.compact) {
          // What the agent does: the history shrinks, then the event is emitted.
          session.messages = historyOf(22_000);
          options.onStatus?.("memory_compacted");
        }
        yield "\x11 y listo.";
        readings.push("END");
      },
      estimateActiveToolsTokens: () => 2_000,
      getLastTurnUsage: () => undefined,
      getLastTurnModel: () => "lmstudio/qwen3.6-27b",
    },
    actions: {
      pushTranscript: () => {},
      streamText: () => {},
      draw: () => readings.push(state.contextTokens as number | undefined),
      startSpinner: () => {},
      stopSpinner: () => {},
      resetInput: () => {},
      rememberHistory: () => {},
      getActivePalette: () => ({}),
      getMentionContext: () => undefined,
    },
  } as unknown as InputHandlerContext;

  await handleInputTurn("seguí", ctx);
  return { readings, finalTokens: state.contextTokens as number | undefined };
}

/** The readings taken while the turn was still streaming. */
const duringTurn = (readings: (number | undefined | "END")[]): number[] =>
  readings
    .slice(0, readings.indexOf("END") === -1 ? 0 : readings.indexOf("END"))
    .filter((r): r is number => typeof r === "number");

describe("the context bar during a turn that compacts", () => {
  it("drops to the compacted size as soon as it happens, not at the end of the turn", async () => {
    const { readings } = await runTurnThatCompacts({ compact: true });
    const mid = duringTurn(readings);

    expect(mid.length).toBeGreaterThan(0);
    // 22k of history + 2k of tool schemas.
    expect(mid.at(-1)).toBeGreaterThan(20_000);
    expect(mid.at(-1)).toBeLessThan(26_000);
  });

  it("counts the tools schema in that reading, as the end-of-turn one does", async () => {
    const { readings } = await runTurnThatCompacts({ compact: true });
    expect(duringTurn(readings).at(-1)).toBe(22_000 + 2_000);
  });

  it("leaves the bar alone mid-turn when nothing compacted", async () => {
    const { readings } = await runTurnThatCompacts({ compact: false });
    // A turn that did not compact must not pay for a whole-history estimate mid-flight: the
    // end-of-turn reading is the only one, exactly as before.
    expect(duringTurn(readings).length).toBe(0);
  });
});
