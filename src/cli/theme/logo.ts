import { REI_LOGO } from "../rei-logo.js";
import { paint } from "./palette.js";

/**
 * The welcome logo in the active theme: the █ letters in one role, the box-drawing shadow in
 * another, spaces left bare so the gaps are the terminal's own background.
 *
 * Painted per run of same-kind characters rather than per character — one escape pair per run
 * keeps the string short enough that redrawing it costs nothing.
 */
export function renderLogo(logo: string = REI_LOGO): string {
  return logo.replace(/█+|[^\s█]+/g, (run) =>
    paint(run.startsWith("█") ? "logoBlock" : "logoShadow", run),
  );
}
