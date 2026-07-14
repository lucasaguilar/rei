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
): Promise<{ text: string; allUnchanged: boolean }> {
  const { workspacePath, logger, emitStatus, toRel, currentContent, virtualFiles, alreadyProvided } =
    ctx;

  logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
  emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);

  const parts: string[] = [];
  let considered = 0;
  let unchanged = 0;
  for (const raw of paths) {
    const f = toRel(raw); // normalize absolute in-workspace paths to the virtual-tree key
    const cur = await currentContent(f);
    considered += 1;

    // Dedup: the file is UNCHANGED since we last delivered its FULL content — re-reading makes no
    // progress. Return a forceful pointer instead of re-dumping it. Because read_files is uncapped
    // (see below) the "you already have it" claim is always truthful: we only reach this branch when
    // the previously-stored value is the whole file, never a truncated view.
    if (cur !== "" && alreadyProvided.get(f) === cur) {
      unchanged += 1;
      parts.push(
        `--- File: ${f} ---\nYou ALREADY have the full content of this file above and it is ` +
          `UNCHANGED. Do NOT read it again. Reuse what you have and produce your deliverable NOW ` +
          `(emit edit_file/create_file, or write your final answer/plan).`,
      );
      continue;
    }

    if (cur !== "") {
      // Deliver the full current content (pending virtual edit or disk) and record EXACTLY what we
      // sent. read_files intentionally sends the WHOLE file (no truncation), so storing `cur` is the
      // same as storing what the model saw — the dedup above can never fire on a partial view.
      parts.push(`--- File: ${f} ---\n\`\`\`\n${virtualFiles.has(f) ? virtualFiles.get(f) : cur}\n\`\`\``);
      alreadyProvided.set(f, cur);
    } else {
      // Empty/unreadable — render the "could not read" note; do NOT dedup an empty result.
      parts.push((await buildFileContextMessage(workspacePath, [f])).trimStart());
    }
  }

  // A read that returned ONLY already-provided files made no progress — signal it so the caller can
  // escalate it like a blocked repeat (the classic "re-read the same file forever" loop).
  return { text: "\n" + parts.join("\n\n"), allUnchanged: considered > 0 && unchanged === considered };
}
