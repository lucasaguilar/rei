import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Confines the read tools of a turn to one directory, and keeps `.rei/` out of reach.
 *
 * Built for channels that serve many people from one workspace (WhatsApp): every conversation is
 * stored there as .rei/sessions/wa-<number>.json, and a workspace-scoped read_files / list_files /
 * grep_code let one customer ask for another's. `readRoot` is also what a support or sales role
 * narrows to its knowledge base — the catalog, not the source code or the internal notes beside it.
 *
 * Paths are compared after resolving symlinks and `..`, so neither an absolute path nor
 * `kb/../.rei/…` climbs out.
 */

const READ_TOOLS = new Set(["read_files", "list_files", "grep_code"]);

/** What the dispatcher does with a scoped call: refuse it outright, or run it and pass the result
 *  through `finish` (which notes refused paths and drops any `.rei/` line that slipped through). */
export interface ScopedReadCall {
  refused?: string;
  finish: (result: string) => string;
}

/** Real path of `p`, or of its nearest existing ancestor plus the rest — a file that does not
 *  exist yet must still be judged by where it WOULD be. */
function realish(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realish(parent), path.basename(p));
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

function inScope(raw: string, workspacePath: string, readRoot: string): boolean {
  const target = realish(path.resolve(workspacePath, raw));
  return (
    within(target, realish(readRoot)) &&
    !within(target, realish(path.join(workspacePath, ".rei")))
  );
}

/** A listing/search line that names a file under .rei/ — dropped even if the walk reached one. */
const REI_LINE = /(^|[\s/])\.rei\//;

/**
 * Applies the scope to one call, MUTATING `args` (dropped paths, a default search root).
 * Returns undefined for tools it does not govern.
 */
export function scopeReadCall(
  tool: string,
  args: Record<string, unknown>,
  workspacePath: string,
  readRoot: string,
): ScopedReadCall | undefined {
  if (!READ_TOOLS.has(tool)) return undefined;
  const where = path.relative(workspacePath, readRoot) || ".";
  const refusal = (what: string) =>
    `ERROR: ${what} is outside what this channel may read (${where}). Only files under it are available.`;

  if (tool === "read_files") {
    const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    const outside = paths.filter((p) => !inScope(p, workspacePath, readRoot));
    args.paths = paths.filter((p) => inScope(p, workspacePath, readRoot));
    if (outside.length === paths.length && outside.length > 0) {
      return { refused: refusal(outside.join(", ")), finish: (r) => r };
    }
    const note = outside.length > 0 ? `${refusal(outside.join(", "))}\n` : "";
    return { finish: (r) => note + r };
  }

  // list_files / grep_code: an explicit root must be in scope; without one, search from readRoot.
  const glob = typeof args.glob === "string" ? args.glob : "";
  if (/(^|\/)\.rei(\/|$)/.test(glob)) return { refused: refusal(glob), finish: (r) => r };
  if (typeof args.path === "string" && args.path) {
    if (!inScope(args.path, workspacePath, readRoot)) {
      return { refused: refusal(args.path), finish: (r) => r };
    }
  } else if (where !== ".") {
    args.path = where;
  }
  return {
    finish: (r) =>
      r
        .split("\n")
        .filter((line) => !REI_LINE.test(line))
        .join("\n"),
  };
}
