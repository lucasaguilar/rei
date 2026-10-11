import * as path from "path";
import { CRT_SHADER } from "./crt-shader.js";

export { CRT_SHADER };

type Fs = {
  mkdir: (dir: string) => void;
  writeFile: (file: string, data: string) => void;
};

type Options = { env: NodeJS.ProcessEnv; home: string; fs: Fs };

/**
 * `/theme crt` — the half of the Hercules look REI cannot draw. Scanlines, bloom and the curved
 * glass are the terminal's renderer, so this installs what each terminal can load and says plainly
 * where nothing can be done.
 *
 * It never edits the terminal's own config: that file is the user's, and a rewrite that drops a
 * comment or a key is a worse outcome than one line to paste.
 */
export function crtSetup({ env, home, fs }: Options): string {
  if (env.TERM_PROGRAM === "rei-desktop") {
    return (
      `[REI] REI Desktop already draws the tube — scanlines, glow, curved glass, phosphor trails.\n` +
      `  Tune them with the knobs under the screen; A / G / V switches the phosphor.`
    );
  }

  if (env.TERM_PROGRAM === "ghostty") {
    const configDir = env.XDG_CONFIG_HOME || path.join(home, ".config");
    const dir = path.join(configDir, "ghostty", "shaders");
    const target = path.join(dir, "rei-crt.glsl");
    fs.mkdir(dir);
    fs.writeFile(target, CRT_SHADER);
    return (
      `[REI] CRT shader installed: ${target}\n` +
      `  Add this line to your Ghostty config, then reload it (⌘⇧, on macOS):\n\n` +
      `    custom-shader = ${target}\n\n` +
      `  Pair it with /theme amber or /theme green. Remove the line to turn it off.`
    );
  }

  if (env.WT_SESSION) {
    return (
      `[REI] Windows Terminal draws its own CRT effect. In settings.json, inside your profile:\n\n` +
      `    "experimental.retroTerminalEffect": true\n\n` +
      `  Pair it with /theme amber or /theme green.`
    );
  }

  return (
    `[REI] This terminal cannot run a CRT effect — scanlines and glow are drawn by the terminal,\n` +
    `  not by REI. Ghostty (custom shaders: run /theme crt there) and Windows Terminal (retro\n` +
    `  effect) can, and cool-retro-term emulates a CRT outright. /theme amber works everywhere.`
  );
}
