import type {
  ActivePalette,
  ChatRendererState,
  ChatUIState,
} from "../models/chat.types.js";
import type { ChatSession } from "../../chat/types.js";
import { stickyIndicators } from "./startup-gauge.helper.js";
import { sessionIndicators } from "./chat.helpers.js";

/**
 * Copies the live UI state into the shape the renderer draws from.
 *
 * It is a COPY, field by field, and that is the whole hazard: a field added to ChatUIState and to
 * ChatRendererState — both of which typecheck fine — still shows nothing until it is listed here.
 * That is exactly how the rolling reasoning line came to be written on every token, asserted by its
 * own renderer test, and still invisible on screen: `thinkingTail` was set on one object and read
 * off the other, with nothing in between to carry it.
 *
 * Kept as a named function rather than an inline literal so the seam has somewhere to be tested.
 */
export function buildRenderState(params: {
  state: ChatUIState;
  session: ChatSession;
  palette: ActivePalette;
  cols: number;
  rows: number;
}): ChatRendererState {
  const { state, session, palette, cols, rows } = params;
  return {
    cols,
    rows,
    activePalette: palette,
    selectedCommandIndex: state.selectedCommandIndex,
    historySearchMode: state.historySearchMode,
    historySearchQuery: state.historySearchQuery,
    historySearchIndex: state.historySearchIndex,
    inputHistory: state.inputHistory,
    busy: state.busy,
    activeStatus: state.activeStatus,
    activeStatusText: state.activeStatusText,
    statusStartedAt: state.statusStartedAt,
    thinkingTail: state.thinkingTail,
    ...stickyIndicators(state),
    spinnerIndex: state.spinnerIndex,
    sessionMode: session.mode,
    inputBuffer: state.inputBuffer,
    inputCursor: state.inputCursor,
    ...sessionIndicators(session),
  };
}
