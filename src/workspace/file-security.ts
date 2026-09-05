import * as fs from "fs";
import * as path from "path";

/**
 * Workspace path containment: resolving a model-supplied path to a real on-disk location that is
 * guaranteed to sit inside the workspace.
 *
 * This file used to also carry a file-MODIFY policy (`DEFAULT_FILE_MODIFY_POLICY`,
 * `validateFileTarget`, `describeValidationError`) plus a `file-security.integration.ts` wrapper.
 * Nothing ever called them, so they enforced nothing while reading as an implemented safeguard —
 * the most misleading kind of dead code in a security file. Removed. The real read-side guard lives
 * in `read-files-handler.ts`.
 */

/**
* Resolve a model-supplied file path to an ABSOLUTE on-disk path inside the workspace.
 *
 * Accepts either a workspace-relative path ("django/forms.py") OR an absolute path
 * that already points inside the workspace ("/testbed/django/forms.py"). Using
 * `path.join(workspacePath, file)` is WRONG for the absolute case:
 *   path.join("/testbed", "/testbed/django/forms.py") === "/testbed/testbed/django/forms.py"
 * i.e. a phantom nested path — the write silently misses the real file. `path.resolve`
 * collapses an absolute second argument to itself, so both forms land on the same file.
 */
export function resolveWorkspacePath(
  filePath: string,
  workspacePath: string,
): string {
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspacePath, filePath);
  return collapseDoubledWorkspaceDir(abs, workspacePath);
}

/**
 * Guard against a model that prefixes the workspace FOLDER NAME onto a relative path — e.g. writing
 * "rei-ocr/x.py" while the workspace already IS ".../rei-ocr", which resolves to the phantom nested
 * ".../rei-ocr/rei-ocr/x.py". The file then lands in the wrong place and every later `run_command`
 * fails to find it (observed: the agent thrashing across paths until the turn budget ran out).
 *
 * We collapse the doubled "<base>/<base>" segment — but ONLY when that nested dir does NOT already
 * exist on disk, so an INTENTIONAL same-named nesting (e.g. Django's "myproject/myproject/") is
 * left untouched. Narrow by design: it fires solely when the path starts with `<workspace-base>/`.
 */
function collapseDoubledWorkspaceDir(abs: string, workspacePath: string): string {
  const ws = path.resolve(workspacePath);
  const base = path.basename(ws);
  if (!base) return abs;
  const doubledPrefix = path.join(ws, base) + path.sep;
  if (!abs.startsWith(doubledPrefix)) return abs;
  try {
    if (fs.existsSync(path.join(ws, base))) return abs; // real nested dir → intentional, keep it
  } catch {
    /* unreadable → treat as phantom and collapse */
  }
  return path.join(ws, abs.slice(doubledPrefix.length));
}

/**
 * Canonical workspace-relative form (forward slashes, no leading "./") of a
 * model-supplied path, whether it arrives relative or as an absolute in-workspace
 * path. Used as the stable key for the in-memory edit tree so the SAME file can't be
 * tracked under two different keys (e.g. "django/forms.py" vs "/testbed/django/forms.py").
 */
export function toWorkspaceRelative(
  filePath: string,
  workspacePath: string,
): string {
  const abs = resolveWorkspacePath(filePath, workspacePath);
  const rel = path.relative(path.resolve(workspacePath), abs);
  return rel.split(path.sep).join("/");
}

/**
 * Check if a path is within workspace and doesn't escape via path traversal.
 *
 * @param absPath absolute path to check
 * @param absWorkspace absolute path to workspace root
 */
export function isWithinWorkspace(
  absPath: string,
  absWorkspace: string,
): boolean {
  const resolved = path.resolve(absPath);
  const resolvedWorkspace = path.resolve(absWorkspace);
  const relative = path.relative(resolvedWorkspace, resolved);

  // Treat empty or current-directory relative paths as inside the workspace
  if (relative === "" || relative === ".") {
    return true;
  }

  // Guard against unexpected absolute relative paths
  if (path.isAbsolute(relative)) {
    return false;
  }

  // Reject paths that escape the workspace via parent-directory segments
  if (relative === ".." || relative.startsWith(".." + path.sep)) {
    return false;
  }

  return true;
}

/**
 * Check if path or any parent directories contain symlinks.
 *
 * @param absPath absolute path to check
 * @param absWorkspace absolute workspace root (stop checking after this)
 */
