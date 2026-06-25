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

// 1. Base defaults from cwd/.env (the install's ~/.rei/.env under the wizard, or the
//    workspace itself on a direct `rei` run from inside it).
dotenv.config();

// 2. Resolve the workspace: --workspace <path> arg (the wizard always passes it) → REI_WORKSPACE_PATH.
const argv = process.argv;
const wi = argv.indexOf("--workspace");
const wsDir =
  wi !== -1 && argv[wi + 1] ? argv[wi + 1] : process.env.REI_WORKSPACE_PATH;

// 3. If the workspace differs from cwd, load ITS .env with override so it wins over the base.
if (wsDir) {
  const wsResolved = path.resolve(wsDir);
  const wsEnv = path.join(wsResolved, ".env");
  if (wsResolved !== process.cwd() && fs.existsSync(wsEnv)) {
    dotenv.config({ path: wsEnv, override: true });
  }
}
