import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Side-effect module: load env BEFORE any module that reads process.env at import time.
// MUST be imported first in the entrypoint (ESM evaluates imports in order).
//
// Two files matter, and they are NOT peers:
//
//   <install>/.env   the machine: which backend runs here, where it listens, the API keys.
//   <workspace>/.rei/.env   the project: which model, how it is tuned, how REI behaves.
//
// The wizard runs `npm run dev` from the INSTALL dir (cwd = ~/.rei) so npm finds package.json, and
// passes the real project via `--workspace`. A plain `import "dotenv/config"` therefore loads the
// install's .env and never the workspace's, so per-project config was silently ignored.
//
// Loading the install's file WHOLESALE is the opposite failure, and the one this file now prevents:
// a key the project never mentions still arrives from the install. Opening REI in a fresh folder
// inherited a model, its sampling and a context window from an unrelated project — settings nothing
// on screen accounts for. Only INSTALL_SCOPED keys cross that boundary; everything else must come
// from the workspace or not at all.

/**
 * Keys that describe the MACHINE, not the work: credentials, where a local backend listens, which
 * backend is installed. Everything else — models, sampling, context, REI's own behaviour — is a
 * per-project decision and does not inherit.
 */
const INSTALL_SCOPED = [
  /_API_KEY$/,
  /_TOKEN$/,
  /_SECRET$/,
  /_CLIENT_ID$/,
  /_BASE_URL$/,
  /_REQUEST_TIMEOUT_MS$/,
  /^MODEL_PROVIDER$/,
  /^AGENT_MODEL_PROVIDER$/,
  /^ALLOWED_WORKSPACES$/,
];

const isInstallScoped = (key: string): boolean =>
  INSTALL_SCOPED.some((re) => re.test(key));

/** Escape hatch: restores the old wholesale inheritance if a setup depended on it. */
const inheritAll = process.env.REI_INHERIT_ALL_ENV === "true";

/** Applies a file's variables. `only` filters which keys are allowed through. */
function apply(file: string, only?: (key: string) => boolean): void {
  if (!fs.existsSync(file)) return;
  if (!only) {
    dotenv.config({ path: file, override: true, quiet: true });
    return;
  }
  const parsed = dotenv.parse(fs.readFileSync(file));
  for (const [key, value] of Object.entries(parsed)) {
    // A real shell variable always wins — it was set deliberately, for this run.
    if (only(key) && process.env[key] === undefined) process.env[key] = value;
  }
}

// 1. Resolve the workspace: --workspace <path> (the wizard always passes it) → REI_WORKSPACE_PATH.
const argv = process.argv;
const wi = argv.indexOf("--workspace");
const wsDir =
  wi !== -1 && argv[wi + 1] ? argv[wi + 1] : process.env.REI_WORKSPACE_PATH;
const ws = wsDir ? path.resolve(wsDir) : undefined;

// 2. cwd/.env. Running from inside the project, this IS the project's own (legacy) file and is
//    taken whole; under the wizard it is the install's, and only machine-scoped keys cross.
const cwdIsWorkspace = ws !== undefined && ws === process.cwd();
apply(
  path.join(process.cwd(), ".env"),
  cwdIsWorkspace || inheritAll ? undefined : isInstallScoped,
);

// 3. The workspace's own files, which override the machine's.
if (ws) {
  // Legacy location first, so `.rei/.env` wins during a migration where both exist. Skipped when
  // the workspace IS the cwd — step 2 already read that exact file.
  if (!cwdIsWorkspace) apply(path.join(ws, ".env"));
  // Canonical location, always read: step 2 never reaches it, not even from inside the project.
  apply(path.join(ws, ".rei", ".env"));
}
