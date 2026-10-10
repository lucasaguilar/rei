import type { CommandHandler, CommandResult } from "./command-handler.js";
import { listPersonas, loadPersona } from "../../personas/persona-loader.js";
import { saveSession } from "../session-store.js";

/**
 * `/persona` lists them, `/persona <name>` makes REI that persona for this session, `/persona off`
 * goes back to plain REI. A persona REPLACES REI's identity — unlike `/role`, which layers a posture
 * on it — and is saved with the session. See docs/persona-spec.md.
 */
const PERSONA_RE = /^\/persona(?:\s+(\S+))?$/i;

export const personaCommands: CommandHandler = {
  match: (c) => PERSONA_RE.test(c.trim()),

  run: ({ command, session, workspacePath }): CommandResult => {
    const arg = command.trim().match(PERSONA_RE)?.[1]?.toLowerCase();

    if (!arg) {
      const personas = listPersonas(workspacePath);
      if (personas.length === 0) {
        return {
          success: true,
          recordInSession: false,
          response: "[REI] No personas found in .rei/personas/ or the built-in ones.",
        };
      }
      const NAME = "\x1b[1;36m", ON = "\x1b[1;32m", DIM = "\x1b[2m", WARN = "\x1b[33m", OFF = "\x1b[0m";
      const lines = personas.map((p) => {
        const active = p.name === session.persona;
        const name = `${active ? ON : NAME}${p.name}${OFF}`;
        // A broken persona is listed with its error rather than hidden: a file that silently does
        // not appear is harder to fix than one that says what is wrong with it.
        const detail = p.error ? `${WARN}⚠ ${p.error}${OFF}` : `${DIM}— ${p.description}${OFF}`;
        return `  ${active ? `${ON}▶${OFF}` : " "} ${name} ${detail}`;
      });
      const header = session.persona
        ? `Active persona: ${ON}${session.persona}${OFF} (/persona off for plain REI)`
        : "No active persona — this is plain REI.";
      return {
        success: true,
        recordInSession: false,
        response: `[REI] ${header}\nAvailable personas:\n${lines.join("\n")}`,
      };
    }

    if (arg === "off" || arg === "none" || arg === "clear") {
      const next = { ...session, persona: undefined };
      saveSession(workspacePath, next);
      return {
        success: true,
        recordInSession: false,
        response: session.persona
          ? `[REI] Persona '${session.persona}' off — back to plain REI.`
          : "[REI] No persona was active — this is plain REI.",
        newSession: next,
      };
    }

    // Validated before it is set: a persona that cannot load would fail every following turn.
    const loaded = loadPersona(arg, workspacePath);
    if (!loaded.ok) {
      return { success: false, recordInSession: false, response: `[REI] ${loaded.error}` };
    }
    const persona = loaded.persona;
    const next = { ...session, persona: persona.name };
    saveSession(workspacePath, next);
    const roleNote = session.activeRole
      ? ` The role '${session.activeRole}' is ignored while a persona is active.`
      : "";
    const modelNote = persona.preferredModel ? ` Runs on ${persona.preferredModel}.` : "";
    return {
      success: true,
      recordInSession: false,
      response: `[REI] Persona '${persona.name}' active — ${persona.description.replace(/\.$/, "")}.${modelNote}${roleNote}`,
      newSession: next,
    };
  },
};
