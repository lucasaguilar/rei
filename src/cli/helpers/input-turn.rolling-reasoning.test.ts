import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../chat/session-store.js", () => ({ saveSession: vi.fn() }));
vi.mock("../vision-sidecar.js", () => ({ describeAttachedImages: vi.fn(async () => null) }));

import { handleInputTurn } from "./input-turn.helpers.js";
import type { InputHandlerContext } from "../models/input-handler.types.js";

const THINKING = "\x10";
const TEXT = "\x11";

/**
 * Where the reasoning goes. Streamed to stdout it erases the drawn block on every token, taking
 * the input prompt with it — so by default it rides on the status line as drawn state instead, and
 * only `--verbose` dumps the stream. These check WHICH surface receives it.
 */
async function runTurn(chunks: string[]) {
  const streamed: string[] = [];
  /** state.thinkingTail as it stood after each chunk was consumed — the status row's timeline. */
  const tails: (string | undefined)[] = [];
  const state: Record<string, unknown> = {};

  const ctx = {
    state,
    session: { messages: [], mode: "agent" },
    transcript: [],
    workspacePath: "/tmp",
    agent: {
      async *streamTurn() {
        for (const c of chunks) {
          yield c;
          // Control is back here only once the turn has processed that chunk, so this reads the
          // state exactly as the next draw would have found it.
          tails.push(state.thinkingTail as string | undefined);
        }
      },
      estimateActiveToolsTokens: () => 0,
      getLastTurnUsage: () => undefined,
      getLastTurnModel: () => "lmstudio/qwen3.6-27b",
    },
    actions: {
      pushTranscript: () => {},
      streamText: (v: string) => streamed.push(v),
      draw: () => {},
      startSpinner: () => {},
      stopSpinner: () => {},
      resetInput: () => {},
      rememberHistory: () => {},
      getActivePalette: () => ({}),
      getMentionContext: () => undefined,
    },
  } as unknown as InputHandlerContext;

  await handleInputTurn("pregunta", ctx);
  // eslint-disable-next-line no-control-regex
  return { live: streamed.join("").replace(/\x1b\[[0-9;]*m/g, ""), tails, state };
}

const savedVerbose = process.env.REI_VERBOSE;
const savedReasoning = process.env.REI_SHOW_REASONING;
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REI_VERBOSE;
  delete process.env.REI_SHOW_REASONING;
});
afterEach(() => {
  if (savedVerbose === undefined) delete process.env.REI_VERBOSE;
  else process.env.REI_VERBOSE = savedVerbose;
  if (savedReasoning === undefined) delete process.env.REI_SHOW_REASONING;
  else process.env.REI_SHOW_REASONING = savedReasoning;
});

describe("the reasoning by default", () => {
  it("never reaches stdout, so the drawn input block survives the think", async () => {
    const { live } = await runTurn([
      `${THINKING}estoy revisando el archivo`,
      `${TEXT}Listo.`,
    ]);
    expect(live).not.toContain("estoy revisando el archivo");
  });

  it("accumulates on the status row as the tokens arrive", async () => {
    const { tails, state } = await runTurn([
      `${THINKING}pensando en voz`,
      `${THINKING} alta`,
    ]);
    expect(tails[0]).toBe("pensando en voz");
    expect(tails[1]).toBe("pensando en voz alta");
    // …and nothing is left over once the turn is done.
    expect(state.thinkingTail).toBeUndefined();
  });

  it("leaves nothing of the thinking on the status row once the turn ends", async () => {
    const { state } = await runTurn([`${THINKING}razonando`, `${TEXT}La respuesta.`]);
    expect(state.thinkingTail).toBeUndefined();
    expect(state.activeStatus).toBeUndefined();
  });

  it("still streams the whole thing under --verbose, which is what verbose is for", async () => {
    process.env.REI_VERBOSE = "true";
    const { live } = await runTurn([`${THINKING}estoy revisando el archivo`, `${TEXT}Listo.`]);
    expect(live).toContain("estoy revisando el archivo");
  });

  it("says nothing at all when the reasoning is switched off", async () => {
    process.env.REI_SHOW_REASONING = "false";
    const { live, tails } = await runTurn([`${THINKING}silencio`, `${TEXT}Listo.`]);
    expect(live).not.toContain("silencio");
    expect(tails.every((t) => t === undefined)).toBe(true);
  });
});
