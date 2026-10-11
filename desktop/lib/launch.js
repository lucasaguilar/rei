import * as fs from "node:fs";
import * as path from "node:path";
import { PHOSPHORS } from "../renderer/phosphors.js";

/**
 * How the desktop starts REI: the repo's own `bin/rei.js chat`, under the SYSTEM node.
 *
 * Not Electron's bundled Node (ELECTRON_RUN_AS_NODE): REI depends on native modules (sharp)
 * compiled for the node that installed them, and they refuse to load under another ABI.
 */
export function reiLaunch({ repoRoot, workspace, phosphor, env }) {
  return {
    command: env.REI_NODE || "node",
    args: [path.join(repoRoot, "bin", "rei.js"), "chat"],
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
    },
  };
}

/** bin/rei.js imports dist/ — a clone that was never built would die with a stack trace. */
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
