import { loadPersona } from "./persona-loader.js";

/**
 * Which persona a CLI session starts as (docs/persona-spec.md, "Activation"). Most recent wins:
 * `--persona` (this run) > the persona saved in the session being resumed > `REI_PERSONA` (the
 * project's default, for NEW sessions only). `/persona` changes it afterwards.
 */
export function chooseStartupPersona(o: {
  flag?: string;
  persisted?: string;
  envDefault?: string;
  /** True when an existing session was loaded (resume / -c / --session with a file). */
  resumed: boolean;
}): { name?: string; from?: "--persona" | "the saved session" | "REI_PERSONA" } {
  if (o.flag?.trim()) return { name: o.flag.trim(), from: "--persona" };
  // A resumed session keeps what it was — including plain REI after /persona off: the config default
  // must not quietly turn a conversation back into a persona the user had switched off.
  if (o.resumed) return o.persisted ? { name: o.persisted, from: "the saved session" } : {};
  if (o.envDefault?.trim()) return { name: o.envDefault.trim(), from: "REI_PERSONA" };
  return {};
}

/**
 * The persona to start with, validated. An invalid one does not stop the CLI: it is reported and the
 * session starts as plain REI — the person at the keyboard can fix it with /persona.
 */
export function startupPersona(o: {
  flag?: string;
  persisted?: string;
  envDefault?: string;
  resumed: boolean;
  workspacePath: string;
}): { persona?: string; warning?: string } {
  const chosen = chooseStartupPersona(o);
  if (!chosen.name) return {};
  const loaded = loadPersona(chosen.name, o.workspacePath);
  if (loaded.ok) return { persona: loaded.persona.name };
  return {
    warning: `Persona "${chosen.name}" (from ${chosen.from}) can't be used: ${loaded.error} Starting as plain REI — /persona lists the ones available.`,
  };
}
