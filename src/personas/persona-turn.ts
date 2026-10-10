import { loadPersona, resolvePersonaTools, type Persona } from "./persona-loader.js";
import { buildPersonaSystemMessage } from "./persona-prompt.js";
import { within, realish } from "../agent-mode/tools-loop/read-scope.js";

/**
 * Everything a persona decides for one turn (docs/persona-spec.md, phase 3), resolved in one place
 * so the Agent only has to apply it: the prompt that replaces REI's, the tools it may be offered,
 * and the directory it may read.
 */
export interface PersonaTurn {
  persona: Persona;
  systemPrompt: string;
  /** persona.tools ∩ surface ∩ the channel's allowedTools — what is offered AND what may run. */
  allowedTools: string[];
  /** Where the read tools are confined; `.rei/` is refused inside it regardless. */
  readRoot: string;
  /** Tools or patterns the persona listed that this surface does not offer — for the log. */
  dropped: string[];
}

export type PersonaTurnResult = { ok: true; turn: PersonaTurn } | { ok: false; error: string };

export function resolvePersonaTurn(params: {
  name: string;
  workspacePath: string;
  /** What the surface offers in this mode (surfaceToolNames). */
  surfaceTools: readonly string[];
  /** A channel's own restriction (e.g. WhatsApp's read-only set); narrows further. */
  channelAllowedTools?: readonly string[];
  /** A channel's own reading scope; the persona's knowledgeDir may narrow it, never escape it. */
  channelReadRoot?: string;
  /** A public channel's rules, placed before the persona in the prompt. */
  channelPolicy?: string;
}): PersonaTurnResult {
  const loaded = loadPersona(params.name, params.workspacePath);
  if (!loaded.ok) return loaded;
  const persona = loaded.persona;

  const surface = params.channelAllowedTools
    ? params.surfaceTools.filter((t) => params.channelAllowedTools!.includes(t))
    : params.surfaceTools;
  const { tools, dropped } = resolvePersonaTools(persona, surface);

  // Without a channel scope the persona still reads through readRoot — that is what keeps `.rei/`
  // (sessions, logs) out of a persona turn on every surface, not only on WhatsApp.
  const outer = params.channelReadRoot ?? params.workspacePath;
  const readRoot =
    persona.knowledgeDir && within(realish(persona.knowledgeDir), realish(outer))
      ? persona.knowledgeDir
      : outer;

  return {
    ok: true,
    turn: {
      persona,
      systemPrompt: buildPersonaSystemMessage(persona, {
        tools,
        workspacePath: params.workspacePath,
        channelPolicy: params.channelPolicy,
      }),
      allowedTools: tools,
      readRoot,
      dropped,
    },
  };
}
