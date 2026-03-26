import * as fs from "fs/promises";
import * as path from "path";
import type { AgentContextRequest } from "../contracts/agent-response.types.js";

const FULL_READ_MAX_CHARS = 8000;

export interface ContextResolutionResult {
  /** Formatted string ready to be injected as a user message. */
  contextMessage: string;
  /** Absolute paths that were successfully resolved in this round. */
  resolved: string[];
}

/**
 * Resolves a list of AgentContextRequest items against the workspace filesystem.
 *
 * @param requests - Context requests from the model's response.
 * @param workspacePath - Absolute root of the workspace.
 * @param alreadyResolved - Set of absolute paths already included in prior rounds (deduplicate).
 * @returns Formatted context message + list of newly-resolved absolute paths.
 */
export async function resolveContextRequests(
  requests: AgentContextRequest[],
  workspacePath: string,
  alreadyResolved: Set<string>
): Promise<ContextResolutionResult> {
  const sections: string[] = [];
  const resolved: string[] = [];

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

    // Skip if already provided in a previous round.
    if (alreadyResolved.has(absolutePath)) {
      console.warn(`[REI debug] Context request skipped (already resolved): ${relativePath}`);
      continue;
    }

    let content: string;
    try {
      const raw = await fs.readFile(absolutePath, "utf-8");
      if (raw.length <= FULL_READ_MAX_CHARS) {
        content = raw;
      } else {
        content = raw.slice(0, FULL_READ_MAX_CHARS) + "\n... (truncated)";
      }
    } catch {
      console.warn(`[REI debug] Context request skipped (not found): ${relativePath}`);
      continue;
    }

    const reasonNote = req.reason ? ` — ${req.reason}` : "";
    sections.push(`--- ${relativePath}${reasonNote} ---\n${content}`);
    resolved.push(absolutePath);
    alreadyResolved.add(absolutePath);
  }

  const contextMessage =
    sections.length > 0
      ? `Here is the additional context you requested:\n\n${sections.join("\n\n")}\n\nPlease now provide your final response with needsMoreContext: false.`
      : "";

  return { contextMessage, resolved };
}
