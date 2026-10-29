/**
 * @fileoverview Which persona answers on the public channels (WhatsApp, the web widget): one for
 * all of them, chosen by the owner with REI_PUBLIC_PERSONA. Never the coding prompt — that is what a
 * channel without a persona would answer with — so a name that does not load falls back to the
 * shipped `general` and says so at startup instead of failing every customer's turn.
 *
 * @module rei/server/public-persona
 */
import { loadPersona } from "../personas/persona-loader.js";

export const FALLBACK_PERSONA = "general";

export interface PublicPersona {
  name: string;
  /** Why the configured persona is not the one answering. */
  warning?: string;
}

export function resolvePublicPersona(
  workspacePath: string,
  env: Record<string, string | undefined> = process.env,
): PublicPersona {
  const wanted = env.REI_PUBLIC_PERSONA?.trim();
  if (!wanted) return { name: FALLBACK_PERSONA };
  const loaded = loadPersona(wanted, workspacePath);
  if (loaded.ok) return { name: loaded.persona.name };
  return {
    name: FALLBACK_PERSONA,
    warning: `REI_PUBLIC_PERSONA "${wanted}" ignored: ${loaded.error}`,
  };
}

/** The startup banner's line. */
export function describePublicPersona(p: PublicPersona): string {
  return p.warning ? `Public persona: ${p.name} ⚠️  ${p.warning}` : `Public persona: ${p.name}`;
}
