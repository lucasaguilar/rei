import * as fs from "fs/promises";
import * as path from "path";
import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";
import {
  resolveWorkspacePath,
  toWorkspaceRelative,
  isWithinWorkspace,
} from "../../workspace/file-security.js";

/**
 * The in-memory file state for one native agent turn (extracted from executeAgentTurnWithTools —
 * Phase 2). Edits accumulate in `virtualFiles` (path → pending content) instead of touching disk
 * per-edit; disk is read once and cached (`diskCache`); `alreadyProvided` dedups re-reads of files
 * whose shown content hasn't changed. The loop's tool handlers mutate these maps BY REFERENCE, so
 * the factory returns them directly.
 */
export interface VirtualFileTree {
  /** path → pending (edited) content, applied to disk only at the end. */
  virtualFiles: Map<string, string>;
  /** path → original on-disk content (read once; disk isn't mutated during the loop). */
  diskCache: Map<string, string>;
  /** path → exact content already shown to the model, so read_files can skip re-dumping it. */
  alreadyProvided: Map<string, string>;
  /** Normalize a model-supplied path to a canonical workspace-relative key (reads). */
  toRel: (raw: string) => string;
  /** Like toRel but enforces workspace containment — throws for missing/escaping paths (writes). */
  resolveTarget: (raw: unknown) => string;
  /** On-disk content (cached). Empty string when the file doesn't exist. */
  readDisk: (file: string) => Promise<string>;
  /** What the model is editing/should see: its pending content if any, else disk. */
  currentContent: (file: string) => Promise<string>;
  /** The virtual tree as whole-file rewrites from disk (search = exact disk, replace = pending). */
  virtualEdits: () => Promise<AgentSREdit[]>;
  /** Write the given files' current virtual content to disk. */
  persistToDisk: (files: string[]) => Promise<void>;
}

export function createVirtualFileTree(workspacePath: string): VirtualFileTree {
  const virtualFiles = new Map<string, string>();
  const diskCache = new Map<string, string>();
  const alreadyProvided = new Map<string, string>();

  // Accepts both relative ("django/forms.py") and absolute in-workspace ("/testbed/django/forms.py")
  // forms — the latter is common when the workspace itself is an absolute path. Used as the virtual
  // tree / dedup key so absolute and relative refs to the same file collapse.
  const toRel = (raw: string): string => toWorkspaceRelative(raw, workspacePath);

  // Same normalization, but enforces workspace containment — throws (→ ERROR tool result) for a
  // missing arg or a path that escapes the working directory. Used for writes.
  const resolveTarget = (raw: unknown): string => {
    if (!raw || typeof raw !== "string") {
      throw new Error("Missing required 'file' argument.");
    }
    const abs = resolveWorkspacePath(raw, workspacePath);
    if (!isWithinWorkspace(abs, workspacePath)) {
      throw new Error(
        `Path "${raw}" is outside the working directory. Use a path inside it.`,
      );
    }
    return toWorkspaceRelative(raw, workspacePath);
  };

  // Disk is never mutated during the loop, so the original content is stable to cache.
  const readDisk = async (file: string): Promise<string> => {
    if (!diskCache.has(file)) {
      diskCache.set(
        file,
        await fs
          .readFile(resolveWorkspacePath(file, workspacePath), "utf-8")
          .catch(() => ""),
      );
    }
    return diskCache.get(file)!;
  };

  const currentContent = async (file: string): Promise<string> =>
    virtualFiles.has(file) ? virtualFiles.get(file)! : await readDisk(file);

  const virtualEdits = async (): Promise<AgentSREdit[]> => {
    const out: AgentSREdit[] = [];
    for (const [file, content] of virtualFiles) {
      out.push({ file, search: await readDisk(file), replace: content });
    }
    return out;
  };

  const persistToDisk = async (files: string[]): Promise<void> => {
    for (const f of files) {
      const abs = resolveWorkspacePath(f, workspacePath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, virtualFiles.get(f)!, "utf-8");
    }
  };

  return {
    virtualFiles,
    diskCache,
    alreadyProvided,
    toRel,
    resolveTarget,
    readDisk,
    currentContent,
    virtualEdits,
    persistToDisk,
  };
}
