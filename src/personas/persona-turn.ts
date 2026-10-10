import { loadPersona, resolvePersonaTools, type Persona } from "./persona-loader.js";
import { buildPersonaSystemMessage } from "./persona-prompt.js";
import { within, realish } from "../agent-mode/tools-loop/read-scope.js";
import { loadSkills } from "../skills/skill-loader.js";

const WRITE_TOOLS = ["create_file", "edit_file", "rewrite_file"];

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
  /** The only files it may write — the write scope enforces it on every write. */
  writeGlob?: string;
  /** The only skills use_skill may load; undefined = no use_skill. */
  skillNames?: string[];
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
  const resolved = resolvePersonaTools(persona, surface);
  const dropped = [...resolved.dropped];
  // Write tools only with a writeGlob: without one there is no scope to write into, and in agent mode
  // the write scope would otherwise be unrestricted — listing edit_file must not mean "anywhere".
  const tools = persona.writeGlob
    ? resolved.tools
    : resolved.tools.filter((t) => {
        const write = WRITE_TOOLS.includes(t);
        if (write) dropped.push(`${t} (no writeGlob)`);
        return !write;
      });

  // use_skill only with skills, and only those that exist; a channel that does not allow it caps it.
  let skillNames: string[] | undefined;
  if (persona.skills?.length) {
    const known = new Set(loadSkills(params.workspacePath).map((s) => s.name));
    skillNames = persona.skills.filter((n) => known.has(n));
    for (const n of persona.skills) if (!known.has(n)) dropped.push(`skill ${n} (not found)`);
    const channelAllows = !params.channelAllowedTools || params.channelAllowedTools.includes("use_skill");
    if (skillNames.length > 0 && channelAllows) tools.push("use_skill");
    else skillNames = undefined;
  }

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
        skillNames,
      }),
      allowedTools: tools,
      readRoot,
      writeGlob: persona.writeGlob,
      skillNames,
      dropped,
    },
  };
}
