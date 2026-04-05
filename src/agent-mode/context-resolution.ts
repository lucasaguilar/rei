import * as path from "path";
import type { AgentContextRequest } from "../contracts/agent-decision.types.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import type { ContextResolutionResult } from "./models/context-resolution.types.js";
import {
  buildAllowedPathSet,
  buildContextMessage,
  dedupeContextRequests,
  isSensitiveContextPath,
  normalizeWorkspaceRelativePath,
  readContextFileContent,
  resolveWorkspaceRealPath,
} from "./helpers/context-resolution.helpers.js";

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
 * @param alreadyResolved - Set of workspace-relative paths already included in prior rounds (deduplicate).
 * @param scannedFiles - Allowlist of files produced by scanWorkspace().
 * @returns Formatted context message + list of newly-resolved workspace-relative paths.
 */
export async function resolveContextRequests(
  requests: AgentContextRequest[],
  workspacePath: string,
  alreadyResolved: Set<string>,
  scannedFiles: FileMeta[],
): Promise<ContextResolutionResult> {
  const sections: string[] = [];
  const resolvedPaths: string[] = [];
  const allowedPaths = buildAllowedPathSet(scannedFiles);
  const uniqueRequests = dedupeContextRequests(requests);

  for (const req of uniqueRequests) {
    let relativePath = normalizeWorkspaceRelativePath(req.path);
    let absolutePath = path.resolve(workspacePath, relativePath);

    // Fallback: model may request .js when the real file is .ts (ESM convention)
    if (!allowedPaths.has(relativePath) && relativePath.endsWith(".js")) {
      const tsVariant = relativePath.replace(/\.js$/, ".ts");
      if (allowedPaths.has(tsVariant)) {
        relativePath = tsVariant;
        absolutePath = path.resolve(workspacePath, relativePath);
      }
    }

    if (!allowedPaths.has(relativePath)) {
      continue;
    }

    if (isSensitiveContextPath(relativePath)) {
      continue;
    }

    if (alreadyResolved.has(relativePath)) {
      continue;
    }

    const realAbsolutePath = await resolveWorkspaceRealPath(
      absolutePath,
      workspacePath,
    );
    if (!realAbsolutePath) {
      continue;
    }

    const content = await readContextFileContent(realAbsolutePath);
    if (content === null) {
      continue;
    }

    const reasonNote = req.reason ? ` — ${req.reason}` : "";
    sections.push(`--- ${relativePath}${reasonNote} ---\n${content}`);
    resolvedPaths.push(relativePath);
    alreadyResolved.add(relativePath);
  }

  const contextMessage = buildContextMessage(sections);

  return { contextMessage, resolvedPaths };
}
