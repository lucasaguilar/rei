import * as fs from "fs/promises";
import * as path from "path";
import type { AgentContextRequest } from "../contracts/agent-decision.types.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";

const FULL_READ_MAX_CHARS = 8000;

// Denylist of sensitive file names (exact, case-insensitive) that must never be served.
const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".netrc",
  ".htpasswd",
]);

// Denylist of sensitive file extensions that must never be served.
const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
]);

export interface ContextResolutionResult {
  /** Formatted string ready to be injected as a user message. */
  contextMessage: string;
  /** Absolute paths that were successfully resolved in this round. */
  resolved: string[];
}

/**
 * Resolves a list of AgentContextRequest items against the workspace filesystem.
 *
 * Security guardrails applied before any file is read:
 * 1. **Allowlist** – only files present in `scannedFiles` (produced by scanWorkspace) are served.
 * 2. **Sensitive-file denylist** – blocks known credential/secret file names and extensions.
 * 3. **Path-containment** – resolves symlinks via `fs.realpath` and confirms the real path
 *    stays within `workspacePath`, preventing symlink-escape attacks.
 *
 * @param requests - Context requests from the model's response.
 * @param workspacePath - Absolute root of the workspace.
 * @param alreadyResolved - Set of absolute paths already included in prior rounds (deduplicate).
 * @param scannedFiles - Allowlist of files produced by scanWorkspace().
 * @returns Formatted context message + list of newly-resolved absolute paths.
 */
export async function resolveContextRequests(
  requests: AgentContextRequest[],
  workspacePath: string,
  alreadyResolved: Set<string>,
  scannedFiles: FileMeta[]
): Promise<ContextResolutionResult> {
  const sections: string[] = [];
  const resolved: string[] = [];

  // Build a set of workspace-relative paths from the scan allowlist.
  const allowedPaths = new Set(scannedFiles.map((f) => f.path.replace(/\\/g, "/")));

  // Deduplicate incoming requests by path before resolution.
  const seen = new Set<string>();
  const uniqueRequests = requests.filter((req) => {
    const normalized = req.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  for (const req of uniqueRequests) {
    const relativePath = req.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const absolutePath = path.resolve(workspacePath, relativePath);

    // --- Security check 1: allowlist ---
    // Only serve files that were discovered during workspace scanning.
    if (!allowedPaths.has(relativePath)) {
      continue;
    }

    // --- Security check 2: sensitive-file denylist ---
    const fileName = path.basename(relativePath).toLowerCase();
    const fileExt = path.extname(relativePath).toLowerCase();
    if (SENSITIVE_FILE_NAMES.has(fileName) || SENSITIVE_EXTENSIONS.has(fileExt)) {
      continue;
    }

    // Skip if already provided in a previous round.
    if (alreadyResolved.has(absolutePath)) {
      continue;
    }

    // --- Security check 3: symlink-escape prevention ---
    // Resolve the real path and verify it stays within workspacePath.
    let realAbsolutePath: string;
    try {
      realAbsolutePath = await fs.realpath(absolutePath);
    } catch {
      continue;
    }

    const normalizedWorkspace = path.resolve(workspacePath);
    const withinWorkspace =
      realAbsolutePath === normalizedWorkspace ||
      realAbsolutePath.startsWith(normalizedWorkspace + path.sep);
    if (!withinWorkspace) {
      continue;
    }

    let content: string;
    try {
      const raw = await fs.readFile(realAbsolutePath, "utf-8");
      if (raw.length <= FULL_READ_MAX_CHARS) {
        content = raw;
      } else {
        content = raw.slice(0, FULL_READ_MAX_CHARS) + "\n... (truncated)";
      }
    } catch {
      continue;
    }

    const reasonNote = req.reason ? ` — ${req.reason}` : "";
    sections.push(`--- ${relativePath}${reasonNote} ---\n${content}`);
    resolved.push(absolutePath);
    alreadyResolved.add(absolutePath);
  }

  const contextMessage =
    sections.length > 0
      ? `Here is the additional context you requested:\n\n${sections.join("\n\n")}`
      : "";

  return { contextMessage, resolved };
}
