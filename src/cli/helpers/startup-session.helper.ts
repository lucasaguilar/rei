import { resolveDefaultSessionMode, type ChatSession } from "../../chat/types.js";
import type { PersistedSession } from "../../chat/session-store.js";
import { startupPersona } from "../../personas/persona-startup.js";

/**
 * The session the interactive CLI opens with: the resumed one rebuilt from disk, or a fresh one —
 * and who REI is in it. Persona precedence: --persona > the resumed session's > REI_PERSONA (new
 * sessions only). An invalid persona does not stop the CLI: it comes back as `personaWarning`, shown
 * once the UI is up, and the session starts as plain REI.
 */
export function buildStartupSession(
  existing: PersistedSession | null,
  workspacePath: string,
  personaFlag?: string,
): { session: ChatSession; personaWarning?: string } {
  const session: ChatSession = existing
    ? {
        messages: existing.messages,
        mode: existing.mode,
        createdAt: existing.createdAt,
        summary: existing.summary,
      }
    : { messages: [], mode: resolveDefaultSessionMode() };
  const start = startupPersona({
    flag: personaFlag,
    persisted: existing?.persona,
    envDefault: process.env.REI_PERSONA,
    resumed: Boolean(existing),
    workspacePath,
  });
  session.persona = start.persona;
  return { session, personaWarning: start.warning };
}
