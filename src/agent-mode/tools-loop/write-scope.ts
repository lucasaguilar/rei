/**
 * @fileoverview Which paths a mode may write to.
 *
 * `agent` writes anywhere in the workspace — that is its job. `planning` used to write NOTHING, so
 * a spec or a plan could only exist as prose in the transcript, leaving `/savespec` to guess which
 * message was the spec. That guess fails whenever the model never produced one.
 *
 * Giving planning a NARROW write scope fixes that without turning it into agent: it can persist the
 * artifacts the spec-driven flow is made of (specs, plans, docs) and still cannot touch source.
 * The distinction that makes the mode useful is preserved.
 *
 * The gate lives here and is applied when a write EXECUTES, not by hiding the tools — same shape as
 * the command allow-list: offering a capability and authorizing a specific use are separate steps,
 * and a refusal the model can read teaches it more than a tool that silently isn't there.
 *
 * @module rei/agent-mode/tools-loop/write-scope
 */

import * as path from "node:path";

/** Directories `planning` may create or edit files in (workspace-relative). */
const PLANNING_WRITE_DIRS = [".rei/specs", ".rei/plans", "docs"];

export interface WriteScope {
  /** True when `mode` may write anywhere (agent). */
  unrestricted: boolean;
  /** Allowed workspace-relative directories when restricted. */
  dirs: string[];
  /** A role's `writeGlob`, when one is active — narrows the scope further. */
  glob?: string;
}

/**
 * The scope for a mode, optionally narrowed by an active role's `writeGlob`.
 *
 * A role declares the ONLY files it may write — an auditor persists `plan.review.md` and touches
 * nothing else. The field used to be parsed and then ignored, so a role that promised to stay out
 * of your source could edit it; the mode alone kept it honest. Now the glob applies ON TOP of the
 * mode: it can only ever narrow, never widen, so a role cannot grant itself agent's reach.
 */
export function writeScopeForMode(
  mode: string | undefined,
  roleWriteGlob?: string,
): WriteScope {
  const base: WriteScope =
    mode === "agent" || mode === undefined
      ? { unrestricted: true, dirs: [] }
      : { unrestricted: false, dirs: PLANNING_WRITE_DIRS };
  if (!roleWriteGlob) return base;
  // A glob makes the scope restricted even under agent — that is the point of declaring one.
  return { ...base, unrestricted: false, glob: roleWriteGlob };
}

/** Matches a `writeGlob` against a path's BASENAME as well as the full relative path, so
 *  `*.review.md` catches `.rei/plans/x.review.md` — where such a file actually goes. */
function matchesGlob(relPath: string, glob: string): boolean {
  const toRe = (g: string): RegExp =>
    new RegExp(
      `^${g.split("*").map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`,
      "i",
    );
  const base = relPath.split("/").pop() ?? relPath;
  return toRe(glob).test(base) || toRe(glob).test(relPath);
}

/**
 * Whether `filePath` (as the model wrote it) is inside the scope.
 *
 * Resolves against the workspace and normalizes BEFORE comparing, so `..` cannot walk out of an
 * allowed directory and an absolute path is judged by where it really lands — the same check
 * `rm` and redirect targets already get in command-executor.
 */
export function isWriteAllowed(
  filePath: string,
  workspacePath: string,
  scope: WriteScope,
): boolean {
  if (scope.unrestricted) return true;
  const abs = path.resolve(workspacePath, filePath);

  // A role's glob is checked FIRST and on its own: it is the tighter of the two constraints, and a
  // role that names one is saying "only these files", not "these files anywhere the mode allows".
  if (scope.glob) {
    const rel = path.relative(workspacePath, abs);
    // A path resolving outside the workspace is never in scope, glob or not.
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return matchesGlob(rel, scope.glob);
  }

  return scope.dirs.some((dir) => {
    const root = path.resolve(workspacePath, dir);
    return abs === root || abs.startsWith(root + path.sep);
  });
}

/** The refusal the model sees — names the allowed dirs and the way forward. */
export function writeDeniedMessage(filePath: string, scope: WriteScope): string {
  if (scope.glob) {
    return (
      `ERROR: writing '${filePath}' is not allowed while this role is active. ` +
      `It may only write files matching '${scope.glob}'. ` +
      `Put your output in such a file, or leave the role with /role off.`
    );
  }
  return (
    `ERROR: writing '${filePath}' is not allowed in this mode. ` +
    `Only these directories are writable here: ${scope.dirs.join(", ")}. ` +
    `Write the document there, or switch to agent mode (/mode agent) to change source files.`
  );
}
