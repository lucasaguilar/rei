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
}

/**
 * read_files tool handler. ALWAYS delivers the full current content (pending virtual edit, else disk)
 * — no dedup/guard. If the model asks for a file, it gets the file: a re-request usually means the
 * content fell out of its context (history trimming, or backend truncation in a large repo), so
 * blocking it would leave the model stuck. Trust the tool call.
 */
export async function handleReadFiles(
  paths: string[],
  ctx: ReadFilesContext,
): Promise<{ text: string; allUnchanged: boolean }> {
  const { workspacePath, logger, emitStatus, toRel, currentContent, virtualFiles } = ctx;

  logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
  emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);

  const parts: string[] = [];
  for (const raw of paths) {
    const f = toRel(raw); // normalize absolute in-workspace paths to the virtual-tree key
    const cur = await currentContent(f);
    if (cur !== "") {
      parts.push(`--- File: ${f} ---\n\`\`\`\n${virtualFiles.has(f) ? virtualFiles.get(f) : cur}\n\`\`\``);
    } else {
      parts.push((await buildFileContextMessage(workspacePath, [f])).trimStart());
    }
  }

  // `allUnchanged` retained for the caller's shape but always false now — no re-read is ever blocked.
  return { text: "\n" + parts.join("\n\n"), allUnchanged: false };
}
