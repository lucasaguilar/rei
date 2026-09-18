import type { CommandHandler, CommandResult } from "./command-handler.js";
import {
  activeThemeName,
  isThemeName,
  paint,
  setTheme,
  THEME_NAMES,
} from "../../cli/theme/palette.js";

/**
 * `/theme [name]` — repaints REI's chrome mid-session.
 *
 * Only the chrome and the chat surfaces change. Markdown, syntax highlighting and diff hunks keep
 * their colours in every theme: red/green in a diff is information, and a theme that repaints it
 * has made the output worse to look at while looking nicer.
 */
const THEME_RE = /^\/theme(?:\s+(\S+))?$/i;

/** Themes that assume a dark terminal — worth saying out loud rather than letting it read as a bug. */
const DARK_ONLY = new Set(["matrix"]);

export const themeCommands: CommandHandler = {
  match: (c) => THEME_RE.test(c.trim()),

  run: ({ command }): CommandResult => {
    const requested = command.trim().match(THEME_RE)?.[1]?.toLowerCase();

    if (!requested) {
      const list = THEME_NAMES.map((name) =>
        name === activeThemeName() ? `${name} (active)` : name,
      ).join(" · ");
      return {
        success: true,
        recordInSession: false,
        response:
          `[REI] Theme: ${activeThemeName()}\n` +
          `  Available: ${list}\n` +
          `  /theme <name>  ·  REI_THEME=<name> to start in it\n` +
          `  Diffs and syntax highlighting are never themed — that colour is information.`,
      };
    }

    if (!isThemeName(requested)) {
      return {
        success: false,
        recordInSession: false,
        response:
          `[REI] No theme called '${requested}'. Available: ${THEME_NAMES.join(", ")}.`,
      };
    }

    setTheme(requested);
    const warning = DARK_ONLY.has(requested)
      ? `\n  ${paint("warn", "Built for a dark terminal — on a light background it will be hard to read.")}`
      : "";
    return {
      success: true,
      recordInSession: false,
      response: `[REI] Theme: ${requested}.${warning}`,
    };
  },
};
