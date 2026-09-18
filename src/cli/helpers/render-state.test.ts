import { describe, it, expect } from "vitest";
import { buildRenderState } from "./render-state.helper.js";
import type { ChatUIState } from "../models/chat.types.js";
import type { ChatSession } from "../../chat/types.js";

/**
 * The seam where the rolling reasoning line was lost.
 *
 * `thinkingTail` was written on ChatUIState by the turn, declared on ChatRendererState, drawn by
 * the renderer, and covered by a renderer test — and still nothing appeared on screen, because the
 * copy between the two objects never listed it. Everything typechecked; the field simply fell in
 * the gap. These pin the live fields to the copy.
 */
const session = { messages: [], mode: "agent" } as unknown as ChatSession;

const uiState = (overrides: Partial<ChatUIState> = {}): ChatUIState =>
  ({
    running: true,
    busy: true,
    inputBuffer: "escribiendo",
    inputCursor: 11,
    inputHistory: [],
    historySearchMode: false,
    historySearchQuery: "",
    selectedCommandIndex: 0,
    spinnerIndex: 3,
    sessionMode: "agent",
    ...overrides,
  }) as ChatUIState;

const build = (state: ChatUIState) =>
  buildRenderState({
    state,
    session,
    palette: { kind: "command", items: [] },
    cols: 100,
    rows: 24,
  });

describe("buildRenderState", () => {
  it("carries the rolling reasoning tail through to the renderer", () => {
    const rendered = build(uiState({ thinkingTail: "revisando el gauge" }));
    expect(rendered.thinkingTail).toBe("revisando el gauge");
  });

  it("carries the rest of what a live turn changes", () => {
    const rendered = build(
      uiState({
        activeStatus: "calling_model",
        activeStatusText: "indexando",
        statusStartedAt: 1_700_000_000_000,
        contextTokens: 24_000,
        contextWindow: 100_000,
        modelLabel: "omlx / Qwen3.8-27B-MLX-4bit",
        thinkingTail: "pensando",
      }),
    );

    expect(rendered).toMatchObject({
      activeStatus: "calling_model",
      activeStatusText: "indexando",
      statusStartedAt: 1_700_000_000_000,
      contextTokens: 24_000,
      contextWindow: 100_000,
      modelLabel: "omlx / Qwen3.8-27B-MLX-4bit",
      thinkingTail: "pensando",
      spinnerIndex: 3,
      busy: true,
      inputBuffer: "escribiendo",
      inputCursor: 11,
    });
  });

  it("leaves a field the turn has not set undefined rather than inventing one", () => {
    expect(build(uiState()).thinkingTail).toBeUndefined();
  });
});
