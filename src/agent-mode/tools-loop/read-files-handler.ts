import type { AgentLogger } from "../../core/logger.js";
import { buildFileContextMessage } from "../helpers/patch-helpers.js";

/** Dependencies the read_files handler needs from the loop's virtual-file state. */
export interface ReadFilesContext {
  workspacePath: string;
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
  /** Normalize a model path to the virtual-tree key. */
  toRel: (raw: string) => string;
  /** Pending (virtual) content if edited, else disk. */
  currentContent: (file: string) => Promise<string>;
  /** path → pending content. */
  virtualFiles: Map<string, string>;
  /** path → exact content already shown (mutated here for re-read dedup). */
  alreadyProvided: Map<string, string>;
}

/**
 * read_files tool handler (extracted from executeAgentTurnWithTools — Phase 2). Returns the file
 * contents to feed back to the model, reflecting the model's own pending (virtual) edits so
 * re-reads show the WORKING state. Dedups: a file unchanged since last shown is pointed back to
 * (it's still in history) instead of re-dumped, saving tokens/turns. Mutates `alreadyProvided`.
 */
export async function handleReadFiles(
  paths: string[],
  ctx: ReadFilesContext,
): Promise<string> {
  const { workspacePath, logger, emitStatus, toRel, currentContent, virtualFiles, alreadyProvided } =
    ctx;

  logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
  emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);

  const parts: string[] = [];
  for (const raw of paths) {
    const f = toRel(raw); // normalize absolute in-workspace paths to the virtual-tree key
    const cur = await currentContent(f);
    if (cur !== "" && alreadyProvided.get(f) === cur) {
      parts.push(
        `--- File: ${f} ---\n(unchanged since you last read it above — reuse that content; do not re-read)`,
      );
      continue;
    }
    if (virtualFiles.has(f)) {
      parts.push(`--- File: ${f} ---\n\`\`\`\n${virtualFiles.get(f)}\n\`\`\``);
    } else {
      parts.push((await buildFileContextMessage(workspacePath, [f])).trimStart());
    }
    if (cur !== "") alreadyProvided.set(f, cur);
  }
  return "\n" + parts.join("\n\n");
}
