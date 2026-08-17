import type { Agent } from "../../core/agent.js";
import type { ChatSession } from "../../chat/types.js";
import { formatContextGauge } from "../markdown-renderer.js";
import { getContextWindow } from "../../config/model-runtime.js";
import { resolveModelForMode } from "../../providers/provider-factory.js";
import { resolveModelTuning, setActiveModelTuning } from "../../config/model-tuning.js";
import { resolveActiveModelLabel } from "./input-turn.helpers.js";

/**
 * Pre-resolves the active model's tuning and renders the startup context gauge. The per-turn path
 * (agent.ts) re-sets tuning every turn; this just populates it before the first render so the
 * gauge reflects the configured context window (rei.config.json) instead of the env fallback.
 */
export function renderStartupGauge(
  agent: Agent,
  session: ChatSession,
  workspacePath = process.cwd(),
): string | null {
  setActiveModelTuning(
    resolveModelTuning(resolveModelForMode(session.mode), workspacePath),
  );

  const historyTokens = Math.round(
    session.messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4,
  );
  const startupTokens = historyTokens + agent.estimateActiveToolsTokens(session.mode);

  return formatContextGauge(
    startupTokens,
    getContextWindow(),
    resolveActiveModelLabel(session.mode),
  );
}
