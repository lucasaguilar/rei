import type { ChatSession, SessionMode } from "./types.js";
import { resolveModelForMode } from "../providers/provider-factory.js";
import { loadRole } from "../skills/role-loader.js";

/**
 * Whether a hand-picked `/model` choice still applies.
 *
 * `manualModel` outranks everything (see ChatSession.manualModel), which makes it the one field
 * that can quietly point the whole session at the wrong backend. Two ways it used to:
 *
 *   - Across MODES. `/model agent X` records a choice about the agent slot; `/mode ask` then ran
 *     ask on X too.
 *   - Across PROVIDERS. `/provider ollama` after `/model some-mlx-model` kept the MLX name and
 *     asked Ollama for it — a model that cannot exist there. (`/provider` clears it for exactly
 *     this reason; see provider-commands.)
 *
 * Both read as a status bar that does not move when you change the model, because the pinned
 * choice outranked the change.
 */

/** The model slot a mode draws from — the same split `/model` writes to. */
export function scopeForMode(mode: SessionMode): "agent" | "base" {
  return mode === "agent" ? "agent" : "base";
}

/**
 * The manual model in effect for `mode`, or undefined. A choice with no recorded scope predates
 * the field and is honoured as before — absence must never be read as "wrong scope".
 */
export function activeManualModel(
  session: Pick<ChatSession, "manualModel" | "manualModelScope">,
  mode: SessionMode,
): string | undefined {
  if (!session.manualModel) return undefined;
  if (session.manualModelScope && session.manualModelScope !== scopeForMode(mode)) return undefined;
  return session.manualModel;
}

/**
 * The model this session runs on: the one the turn uses, the status bar names, and — since it is
 * the one already loaded in a local backend — the one anything else should reuse.
 *
 * Most recent explicit choice first: `/model` beats an active role's `preferredModel`, which beats
 * the mode's configured model. The chain lived inline in three places and had already drifted once
 * (the status bar naming a model the turn was not using), so it lives here now.
 */
export function resolveSessionModel(
  session: Pick<ChatSession, "manualModel" | "manualModelScope" | "mode" | "activeRole">,
  workspacePath: string,
): string | undefined {
  const role = session.activeRole ? loadRole(session.activeRole, workspacePath) : null;
  return (
    activeManualModel(session, session.mode) ||
    role?.preferredModel ||
    resolveModelForMode(session.mode)
  );
}
