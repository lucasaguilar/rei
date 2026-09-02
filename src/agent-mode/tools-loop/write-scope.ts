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
}

export function writeScopeForMode(mode: string | undefined): WriteScope {
  if (mode === "agent" || mode === undefined) return { unrestricted: true, dirs: [] };
  return { unrestricted: false, dirs: PLANNING_WRITE_DIRS };
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
  return scope.dirs.some((dir) => {
    const root = path.resolve(workspacePath, dir);
    return abs === root || abs.startsWith(root + path.sep);
  });
}

/** The refusal the model sees — names the allowed dirs and the way forward. */
export function writeDeniedMessage(filePath: string, scope: WriteScope): string {
  return (
    `ERROR: writing '${filePath}' is not allowed in this mode. ` +
    `Only these directories are writable here: ${scope.dirs.join(", ")}. ` +
    `Write the document there, or switch to agent mode (/mode agent) to change source files.`
  );
}
