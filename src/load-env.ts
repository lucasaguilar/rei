import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Side-effect module: load env BEFORE any module that reads process.env at import time.
// MUST be imported first in the entrypoint (ESM evaluates imports in order).
//
// The config wizard (scripts/launch-rei.js) runs `npm run dev` from the INSTALL dir
// (cwd = ~/.rei) so npm finds package.json, and passes the real project via `--workspace`.
// That means a plain `import "dotenv/config"` loads ~/.rei/.env (cwd), NOT the workspace
// .env — so per-workspace config (model, reasoning_effort, context, …) was silently ignored
// and the install's base values always won. Fix: after loading the cwd .env for base
// defaults (API keys, provider), load the WORKSPACE .env with override:true so per-project
// config is authoritative.
//
// A workspace's env lives at `<ws>/.rei/.env` — grouped with the rest of REI's per-project
// state, and covered by the `.rei/` line every REI project already gitignores. The legacy
// `<ws>/.env` is still read, BEFORE it, so existing projects keep working: dropping it would
// not raise an error, it would silently fall back to the install's values — the ghost config
// this layout exists to remove.

/** Layered lowest → highest. Later files override earlier ones. */
function loadIfPresent(file: string): void {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: true, quiet: true });
  }
}

// 1. Base defaults from cwd/.env (the install's ~/.rei/.env under the wizard, or the
//    workspace itself on a direct `rei` run from inside it).
dotenv.config({ quiet: true });

// 2. Resolve the workspace: --workspace <path> arg (the wizard always passes it) → REI_WORKSPACE_PATH.
const argv = process.argv;
const wi = argv.indexOf("--workspace");
const wsDir =
  wi !== -1 && argv[wi + 1] ? argv[wi + 1] : process.env.REI_WORKSPACE_PATH;

// 3. The workspace's own env wins over the install's base.
if (wsDir) {
  const ws = path.resolve(wsDir);
  // Legacy location first, so `.rei/.env` overrides it during a migration where both exist.
  // Skipped when the workspace IS the cwd — step 1 already read that exact file.
  if (ws !== process.cwd()) loadIfPresent(path.join(ws, ".env"));
  // Canonical location, always read: step 1 never reaches it, not even from inside the project.
  loadIfPresent(path.join(ws, ".rei", ".env"));
}
