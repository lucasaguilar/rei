#!/usr/bin/env node
/**
 * Records WHICH commit this build came from, into `.build-info.json` at the repo root.
 *
 * `rei --version` printed `0.1.0` and nothing else — the package version, unchanged for months —
 * so two machines running builds a day apart reported the same thing, and "which build am I on?"
 * could only be answered by grepping dist/ for a string you happened to remember.
 *
 * Two install shapes have to work, and they differ in one crucial way:
 *
 *   install-rei-cli.sh        clones into ~/.rei → git IS available at build time.
 *   install-rei-cli-local.sh  rsyncs the source into ~/.rei, EXCLUDING .git → git is NOT.
 *
 * So when git is unavailable, an existing `.build-info.json` is PRESERVED rather than overwritten
 * with nulls: the local installer stamps it in the source (where git works) and rsync carries it
 * over. Overwriting here would erase the only copy of the answer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".build-info.json");

/** A git command, or null when this is not a checkout (the rsync install) or git is missing. */
function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const commit = git("rev-parse", "--short", "HEAD");

if (!commit) {
  // No git here. Keep whatever a previous stamp left behind; only write a placeholder when there
  // is nothing at all, so the version line can say "unknown" instead of lying.
  if (!existsSync(OUT)) {
    writeFileSync(
      OUT,
      `${JSON.stringify({ commit: null, builtAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  process.exit(0);
}

// A non-empty `--porcelain` means the build includes uncommitted edits, which is worth saying: it
// is exactly the case where the commit hash alone would misdescribe what is running.
const dirty = (git("status", "--porcelain") ?? "").length > 0;
const info = { commit, dirty, builtAt: new Date().toISOString() };

const previous = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
const next = `${JSON.stringify(info, null, 2)}\n`;
if (previous !== next) writeFileSync(OUT, next);
