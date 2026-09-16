import type { Agent } from "../../core/agent.js";
import type { ChatSession } from "../../chat/types.js";
import { formatContextGauge } from "../markdown-renderer.js";
import { getContextWindow } from "../../config/model-runtime.js";
import { resolveModelForMode } from "../../providers/provider-factory.js";
import { resolveModelTuning, setActiveModelTuning } from "../../config/model-tuning.js";
import { resolveActiveModelLabel } from "./input-turn.helpers.js";
import type { PhaseState } from "./turn-display.helpers.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadRole } from "../../skills/role-loader.js";
import { getActive } from "../../chat/active-artifacts.js";
import { resolveSessionModel } from "../../chat/manual-model.js";

/**
 * Pre-resolves the active model's tuning and renders the startup context gauge. The per-turn path
 * (agent.ts) re-sets tuning every turn; this just populates it before the first render so the
 * gauge reflects the configured context window (rei.config.json) instead of the env fallback.
 */
export interface StartupGauge {
  /** The full one-line gauge for the transcript, or null when no window is configured. */
  line: string | null;
  tokens: number;
  window: number;
  model: string;
}

export function renderStartupGauge(
  agent: Agent,
  session: ChatSession,
  workspacePath = process.cwd(),
): StartupGauge {
  setActiveModelTuning(
    resolveModelTuning(resolveModelForMode(session.mode), workspacePath),
  );

  const historyTokens = Math.round(
    session.messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4,
  );
  const startupTokens = historyTokens + agent.estimateActiveToolsTokens(session.mode);

  const window = getContextWindow();
  const model = resolveActiveModelLabel(session.mode);
  // The numbers come back too: they seed the sticky bar so it is populated BEFORE the first turn,
  // rather than appearing only once a turn has finished.
  return {
    line: formatContextGauge(startupTokens, window, model),
    tokens: startupTokens,
    window,
    model,
  };
}

/** The fields the sticky context bar (context bar) reads between draws. */
export interface ContextBar extends PhaseState {
  contextTokens?: number;
  contextWindow?: number;
  modelLabel?: string;
  activeSpec?: string;
  activePlan?: string;
  activeArtifactsMissing?: boolean;
}

/**
 * Everything the sticky block above the prompt reads, as one value.
 *
 * Copying six fields by hand into the render state is six chances to forget the seventh — which is
 * how the bar came to show a model the turn was not using. They move together because they ARE one
 * thing: the state of this session, drawn where it cannot scroll away.
 */
export function stickyIndicators(state: ContextBar): Pick<
  ContextBar,
  "contextTokens" | "contextWindow" | "modelLabel" | "activeSpec" | "activePlan" | "activeArtifactsMissing"
> {
  return {
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow,
    modelLabel: state.modelLabel,
    activeSpec: state.activeSpec,
    activePlan: state.activePlan,
    activeArtifactsMissing: state.activeArtifactsMissing,
  };
}

/**
 * Publishes the active spec/plan for the 📋 indicator.
 *
 * The pointer lives on disk (.rei/active.json) so it survives a restart, which means the renderer —
 * redrawn on every keystroke — must never read it. It is read HERE instead: once, when a command
 * could have changed it. A pointer whose file is gone is flagged, because the alternative is
 * finding out at /runplan, and `/trace` reporting "File not found" on a name nobody recognises.
 */
export function refreshActiveArtifacts(state: ContextBar, workspacePath: string): void {
  const { spec, plan } = getActive(workspacePath);
  const gone = (name: string | undefined, dir: string) =>
    !!name && !fs.existsSync(path.join(workspacePath, ".rei", dir, `${name}.md`));
  state.activeSpec = spec;
  state.activePlan = plan;
  state.activeArtifactsMissing = gone(spec, "specs") || gone(plan, "plans");
}

/**
 * Republishes the reading a session switch would otherwise leave stale.
 *
 * A real turn republishes at its end (inputTurn.publishContextReading), but a mere session change
 * never did: switching /mode from agent → planning renamed the active model in `session`, updated
 * its mode and trimmed its history, yet the sticky bar kept showing the previous turn's
 * `provider / model` — the same label for the old and the new active session. Same for /model,
 * /role (they change the active model) and /clear (it empties history).
 *
 * This runs only when a command mutates the session, so it can afford the small chars→tokens cost
 * that turning avoids — but it uses the EXACT same model resolution as a turn (agent.ts), because
 * that is what just changed: `manualModel ?? activeRole.preferredModel ?? resolveModelForMode(mode)`.
 * It re-sets the tuning (so `getContextWindow()` reflects the new model's window) and overwrites
 * state.contextTokens/contextWindow/modelLabel — the three fields the bar reads (chat-renderer.ts).
 * `session.messages.slice(0, -1)` excludes the last assistant message, matching the turn's estimate.
 */
export function refreshStickyReading(
  state: ContextBar,
  agent: Agent,
  session: ChatSession,
  workspacePath = process.cwd(),
): void {
  // The SAME resolver the turn uses (chat/manual-model.ts). Two derivations of one fact drift —
  // that is exactly how the bar came to name a model the turn was not running on.
  const turnModel = resolveSessionModel(session, workspacePath);

  setActiveModelTuning(resolveModelTuning(turnModel, workspacePath));

  const inputMsgs = session.messages.slice(0, -1);
  const historyTokens = Math.round(
    inputMsgs.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4,
  );

  state.modelLabel = resolveActiveModelLabel(session.mode, turnModel);
  // Seed the same three fields the bar reads (chat-renderer.ts) after a session switch:
  // mode → context window (from the NEW model's tuning), history → estimated tokens.
  state.contextWindow = getContextWindow();
  state.contextTokens = historyTokens + agent.estimateActiveToolsTokens(session.mode);
  refreshActiveArtifacts(state, workspacePath);
}
