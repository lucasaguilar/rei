import * as fs from "fs/promises";
import * as path from "path";
import type { AgentContextRequest } from "../../contracts/agent-decision.types.js";
import type { FileMeta } from "../../workspace/workspace-scanner.js";
import {
  FULL_READ_MAX_CHARS,
  SENSITIVE_EXTENSIONS,
  SENSITIVE_FILE_NAMES,
} from "../constants/context-resolution.constants.js";

export function normalizeWorkspaceRelativePath(pathCandidate: string): string {
  return pathCandidate.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function buildAllowedPathSet(scannedFiles: FileMeta[]): Set<string> {
  return new Set(
    scannedFiles.map((file) => normalizeWorkspaceRelativePath(file.path)),
  );
}

export function dedupeContextRequests(
  requests: AgentContextRequest[],
): AgentContextRequest[] {
  const seen = new Set<string>();

  return requests.filter((request) => {
    const normalized = normalizeWorkspaceRelativePath(request.path);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function isSensitiveContextPath(relativePath: string): boolean {
  const fileName = path.basename(relativePath).toLowerCase();
  const fileExt = path.extname(relativePath).toLowerCase();

  return (
    SENSITIVE_FILE_NAMES.has(fileName) || SENSITIVE_EXTENSIONS.has(fileExt)
  );
}

export async function resolveWorkspaceRealPath(
  absolutePath: string,
  workspacePath: string,
): Promise<string | null> {
  let realAbsolutePath: string;
  try {
    realAbsolutePath = await fs.realpath(absolutePath);
  } catch {
    return null;
  }

  const normalizedWorkspace = path.resolve(workspacePath);
  const withinWorkspace =
    realAbsolutePath === normalizedWorkspace ||
    realAbsolutePath.startsWith(normalizedWorkspace + path.sep);

  return withinWorkspace ? realAbsolutePath : null;
}

export async function readContextFileContent(
  absolutePath: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf-8");
    if (raw.length <= FULL_READ_MAX_CHARS) {
      return raw;
    }

    return raw.slice(0, FULL_READ_MAX_CHARS) + "\n... (truncated)";
  } catch {
    return null;
  }
}

export function buildContextMessage(sections: string[]): string {
  return sections.length > 0
    ? `Here is the additional context you requested:\n\n${sections.join("\n\n")}`
    : "";
}
