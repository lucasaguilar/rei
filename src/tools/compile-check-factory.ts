import { detectProjectType } from "../workspace/project-type.js";
import * as tsCheck from "./typescript-compile-check.js";
import * as csCheck from "./csharp-compile-check.js";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import type { GenericVirtualBatchResult } from "./compile-check-core.js";

export async function applyVirtualBatch(
  workspacePath: string,
  edits: AgentSREdit[],
): Promise<GenericVirtualBatchResult> {
  const { type } = detectProjectType(workspacePath);

  if (type === "csharp") {
    return (await csCheck.applyVirtualBatch(workspacePath, edits)) as GenericVirtualBatchResult;
  }

  // Default to TypeScript/Angular projects
  return (await tsCheck.applyVirtualBatch(workspacePath, edits)) as GenericVirtualBatchResult;
}

export function formatVirtualBatchResult(
  workspacePath: string,
  result: GenericVirtualBatchResult,
): string {
  const { type } = detectProjectType(workspacePath);

  if (type === "csharp") {
    return csCheck.formatVirtualBatchResult(result as any);
  }

  return tsCheck.formatVirtualBatchResult(result as any);
}
