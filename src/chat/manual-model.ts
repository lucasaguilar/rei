import type { ChatSession, SessionMode } from "./types.js";

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
