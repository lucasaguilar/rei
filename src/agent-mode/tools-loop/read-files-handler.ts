import type { AgentLogger } from "../../core/logger.js";
import {
  isSensitiveFile,
  sensitiveReadsAllowed,
} from "../constants/context-resolution.constants.js";
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

/** Default page size (lines) for read_files, overridable via REI_READ_MAX_LINES. */
function readMaxLines(): number {
  const n = parseInt(process.env.REI_READ_MAX_LINES ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 1200;
}

/**
 * read_files tool handler. ALWAYS delivers content (no dedup/guard) — if the model asks for a file, it
 * gets it. Large files are PAGINATED (offset/limit) so the model receives the whole file in pieces
 * that fit under the model/backend limits, and is told when there's more — never a silent truncation.
 */
export async function handleReadFiles(
  paths: string[],
  ctx: ReadFilesContext,
  opts?: { offset?: number; limit?: number },
): Promise<{ text: string; allUnchanged: boolean }> {
  const { workspacePath, logger, emitStatus, toRel, currentContent } = ctx;

  logger.logInfo(`[tools] read_files: ${paths.join(", ")}`);
  emitStatus(`🔍  [REI] Reading: ${paths.join(", ") || "(none)"}`);

  const limit = opts?.limit && opts.limit > 0 ? Math.floor(opts.limit) : readMaxLines();
  const offset = opts?.offset && opts.offset > 0 ? Math.floor(opts.offset) : 1;

  const parts: string[] = [];
  for (const raw of paths) {
    const f = toRel(raw); // normalize absolute in-workspace paths to the virtual-tree key

    // Credentials are not context. Refusing NAMES the file and says how to allow it, so the model
    // can move on (and the user can opt in) instead of retrying the same read.
    if (isSensitiveFile(f) && !sensitiveReadsAllowed()) {
      logger.logInfo(`[tools] read_files: refused sensitive file ${f}`);
      parts.push(
        `--- File: ${f} ---\n(refused: this file holds credentials, so REI does not serve it to ` +
          `the model. Set REI_ALLOW_SENSITIVE_READS=true to override for this session.)`,
      );
      continue;
    }
    const cur = await currentContent(f); // pending virtual edit if any, else disk
    if (cur === "") {
      parts.push((await buildFileContextMessage(workspacePath, [f])).trimStart());
      continue;
    }

    // Drop a single trailing newline before counting so a POSIX file (which ends in "\n") reports its
    // real line count — otherwise split() adds a spurious empty last line (off-by-one → false paging).
    const lines = (cur.endsWith("\n") ? cur.slice(0, -1) : cur).split("\n");
    const total = lines.length;

    if (offset > total) {
      parts.push(
        `--- File: ${f} ---\n(offset ${offset} is past the end — the file has ${total} line${total === 1 ? "" : "s"}.)`,
      );
      continue;
    }

    const start = offset - 1;
    const slice = lines.slice(start, start + limit);
    const end = start + slice.length; // 1-based line number of the last line delivered

    const paged = offset > 1 || end < total;
    const header = paged ? `--- File: ${f} (lines ${offset}-${end} of ${total}) ---` : `--- File: ${f} ---`;
    let body = `${header}\n\`\`\`\n${slice.join("\n")}\n\`\`\``;
    if (end < total) {
      body += `\n[${total - end} more lines — continue with read_files(paths=["${f}"], offset=${end + 1})]`;
    }
    parts.push(body);
  }

  // `allUnchanged` retained for the caller's shape but always false now — no re-read is ever blocked.
  return { text: "\n" + parts.join("\n\n"), allUnchanged: false };
}
