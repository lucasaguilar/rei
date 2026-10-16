import * as fs from "node:fs";
import * as path from "node:path";
import { PHOSPHORS } from "../renderer/phosphors.js";

/** REI_DESKTOP_DEV=1: run this checkout instead of the installed `rei` — for working on REI itself. */
export const usesCheckout = (env) => env.REI_DESKTOP_DEV === "1";

/**
 * How the desktop starts REI: the same `rei` command the terminal runs, through the user's login
 * shell. Calling `bin/rei.js chat` directly skipped everything the wrapper does — the machine's
 * ~/.rei/.env (API keys, base URLs), the setup wizard on an unconfigured project, the preflight —
 * and, opened from the Dock, it had no PATH to find nvm's node. `-i` because that PATH (nvm,
 * ~/.local/bin) is usually set in .zshrc, which a non-interactive login shell never reads.
 * `configure` is `rei --config`: the wizard, on demand.
 *
 * In checkout mode, it runs under the SYSTEM node, not Electron's bundled one
 * (ELECTRON_RUN_AS_NODE): REI depends on native modules (sharp) compiled for the node that
 * installed them, and they refuse to load under another ABI.
 */
export function reiLaunch({ repoRoot, workspace, phosphor, env, configure = false }) {
  const [command, args] = usesCheckout(env)
    ? [
        env.REI_NODE || "node",
        configure
          ? [path.join(repoRoot, "scripts", "launch-rei.js")]
          : [path.join(repoRoot, "bin", "rei.js"), "chat"],
      ]
    : [env.SHELL || "/bin/zsh", ["-l", "-i", "-c", configure ? "exec rei --config" : "exec rei"]];
  return {
    command,
    args,
    cwd: workspace,
    env: {
      ...env,
      REI_WORKSPACE_PATH: workspace,
      REI_THEME: PHOSPHORS[phosphor].reiTheme,
      // The window owns the glass: REI must not repaint it with OSC 10/11 from inside.
      REI_TERMINAL_COLORS: "off",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "rei-desktop",
      // The window opens links (after asking), but REI cannot know that: neither its own check nor
      // the markdown renderer's recognises "rei-desktop". Said explicitly, once for each of them.
      REI_HYPERLINKS: "on",
      FORCE_HYPERLINK: "1",
    },
  };
}

/** In checkout mode — bin/rei.js imports dist/ — a clone that was never built would die with a stack trace. */
export function missingBuild(repoRoot) {
  return !fs.existsSync(path.join(repoRoot, "dist", "main.js"));
}

/**
 * The first argument that is an existing directory: `npm start -- ~/my-project`. "." is skipped —
 * in development that is the app itself (`electron .`), not a workspace.
 */
export function workspaceFromArgv(
  argv,
  isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
) {
  const dir = argv.find((a) => !a.startsWith("-") && a !== "." && isDir(path.resolve(a)));
  return dir ? path.resolve(dir) : undefined;
}
