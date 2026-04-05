import * as fs from "fs";
import * as path from "path";

/**
 * ⚠️  SECURITY LAYER — File modification policy for agent patch generation.
 *
 * Controls which files can be modified, enforces workspace containment,
 * validates symlinks, and provides policy enforcement for patch application.
 */

export interface FileModifyPolicy {
  /** Directories where modifications are allowed (relative, with trailing /) */
  allowedDirs: string[];
  
  /** Exact file paths that cannot be modified (workspace-relative) */
  deniedFiles: string[];
  
  /** Regex patterns for files that require extra validation before modification */
  requiresValidation: RegExp[];
  
  /** If true, error on any symlinks discovered (prevents breakout attempts) */
  containSymlinks: boolean;
}

/**
 * Default security policy for REI.
 * - Allows: src/, prompts/, docs/ directories
 * - Denies: package.json, config files, .env, lock files, node_modules
 * - Validates: contracts, types, build config
 * - Symlinks: Not allowed (containment)
 */
export const DEFAULT_FILE_MODIFY_POLICY: FileModifyPolicy = {
  allowedDirs: ["src/", "prompts/", "docs/"],
  deniedFiles: [
    "package.json",
    "tsconfig.json",
    "package-lock.json",
    "yarn.lock",
    ".env",
    ".env.local",
    ".env.*.local",
    ".git",
    ".gitignore",
    ".npmrc",
    "node_modules",
    "dist",
    "build",
    ".rei",
  ],
  requiresValidation: [
    /src\/contracts\//,
    /src\/types\//,
    /tsconfig\.json/,
    /\.md$/,
  ],
  containSymlinks: true,
};

export interface FileSecurityError {
  code:
    | "OUTSIDE_WORKSPACE"
    | "NOT_IN_ALLOWED_DIR"
    | "IN_DENIED_LIST"
    | "IS_SYMLINK"
    | "SYMLINK_IN_PATH"
    | "NOT_READABLE";
  message: string;
  path: string;
}

export type ValidationResult = { ok: true } | { ok: false; error: FileSecurityError };

export interface ValidateFileTargetOptions {
  /** Allow targets that do not exist yet (for create-file patches). */
  allowCreate?: boolean;
}

/**
 * Validate that a file path is safe to modify.
 *
 * Checks:
 * 1. Path is within workspace
 * 2. Path is within allowed directories
 * 3. Path is not in denied list
 * 4. Path and parents contain no symlinks (if policy.containSymlinks = true)
 * 5. File is readable
 *
 * @param filePath workspace-relative path (e.g., "src/main.ts")
 * @param workspacePath absolute path to workspace root
 * @param policy security policy to enforce
 */
export function validateFileTarget(
  filePath: string,
  workspacePath: string,
  policy: FileModifyPolicy = DEFAULT_FILE_MODIFY_POLICY,
  options: ValidateFileTargetOptions = {}
): ValidationResult {
  // Normalize paths
  const normalized = normalizePath(filePath);
  const absPath = path.resolve(workspacePath, normalized);
  const absWorkspace = path.resolve(workspacePath);

  // Check 1: Within workspace
  if (!isWithinWorkspace(absPath, absWorkspace)) {
    return {
      ok: false,
      error: {
        code: "OUTSIDE_WORKSPACE",
        message: `Path "${filePath}" escapes workspace boundary`,
        path: filePath,
      },
    };
  }

  // Check 2: In allowed directory
  const inAllowed = policy.allowedDirs.some((dir) => normalized.startsWith(dir));
  if (!inAllowed) {
    return {
      ok: false,
      error: {
        code: "NOT_IN_ALLOWED_DIR",
        message: `Path "${filePath}" is not in allowed directories: ${policy.allowedDirs.join(", ")}`,
        path: filePath,
      },
    };
  }

  // Check 3: Not in denied list
  const inDenied = policy.deniedFiles.some((denied) => {
    // Convert simple glob patterns (with "*" wildcards) to a safe RegExp:
    // 1. Split on "*" (wildcard)
    // 2. Escape regex metacharacters in each literal segment
    // 3. Join segments with ".*" to represent the "*" wildcard
    const pattern = denied
      .split("*")
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${pattern}$`).test(normalized);
  });
  if (inDenied) {
    return {
      ok: false,
      error: {
        code: "IN_DENIED_LIST",
        message: `Path "${filePath}" is in denied list (cannot be modified)`,
        path: filePath,
      },
    };
  }

  // Check 4 & 5: Symlinks and readability
  if (policy.containSymlinks) {
    const symlinkCheck = checkSymlinksInPath(absPath, absWorkspace, {
      allowMissingLeaf: options.allowCreate === true,
    });
    if (symlinkCheck.ok === false) {
      return symlinkCheck;
    }
  }

  // Create-file mode: allow missing leaf if parent directory is accessible.
  if (options.allowCreate === true && !fs.existsSync(absPath)) {
    const parentDir = path.dirname(absPath);
    try {
      fs.accessSync(parentDir, fs.constants.R_OK | fs.constants.W_OK);
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: {
          code: "NOT_READABLE",
          message: `Parent directory for "${filePath}" is not readable/writable`,
          path: filePath,
        },
      };
    }
  }

  // Check 6: File is readable
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
  } catch {
    return {
      ok: false,
      error: {
        code: "NOT_READABLE",
        message: `Path "${filePath}" is not readable or does not exist`,
        path: filePath,
      },
    };
  }

  return { ok: true };
}

/**
 * Check if a path is within workspace and doesn't escape via path traversal.
 *
 * @param absPath absolute path to check
 * @param absWorkspace absolute path to workspace root
 */
export function isWithinWorkspace(absPath: string, absWorkspace: string): boolean {
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
function checkSymlinksInPath(
  absPath: string,
  absWorkspace: string,
  options: { allowMissingLeaf?: boolean } = {}
): ValidationResult {
  let current = path.resolve(absPath);
  const workspace = path.resolve(absWorkspace);

  while (current.startsWith(workspace) && current !== workspace) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          error: {
            code: "SYMLINK_IN_PATH",
            message: `Symlink detected in path: ${current} (security containment)`,
            path: current,
          },
        };
      }
    } catch {
      // If we can't stat (missing parent), that's ok for ancestor check
      // but fail if it's the target file itself
      if (current === absPath) {
        if (options.allowMissingLeaf === true) {
          current = path.dirname(current);
          continue;
        }
        return {
          ok: false,
          error: {
            code: "NOT_READABLE",
            message: `Cannot access path: ${current}`,
            path: current,
          },
        };
      }
    }

    current = path.dirname(current);
  }

  return { ok: true };
}

/**
 * Normalize a file path to use forward slashes and no trailing slash (except root).
 */
function normalizePath(filePath: string): string {
  return path
    .normalize(filePath)
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
}

/**
 * Get a human-readable error message from a validation result.
 */
export function describeValidationError(error: FileSecurityError): string {
  switch (error.code) {
    case "OUTSIDE_WORKSPACE":
      return `Security: Path escapes workspace boundary`;
    case "NOT_IN_ALLOWED_DIR":
      return `Security: Directory not in allowed list`;
    case "IN_DENIED_LIST":
      return `Security: File is in deny list`;
    case "IS_SYMLINK":
      return `Security: Target is a symlink`;
    case "SYMLINK_IN_PATH":
      return `Security: Symlink in path (containment breach)`;
    case "NOT_READABLE":
      return `Security: File not readable or does not exist`;
  }
}
