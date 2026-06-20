import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type {
  AgentSREdit,
  AgentWholeFileEdit,
} from "../contracts/agent-interaction.types.js";
import { applyFileEdits } from "./search-replace.js";

const execFileAsync = promisify(execFile);

export interface BatchPatchApplyItemResult {
  file: string;
  applied: boolean;
  skipped: boolean;
  validationErrors: string[];
}

export interface BatchPatchApplyResult {
  success: boolean;
  results: BatchPatchApplyItemResult[];
}

/**
 * Validates and applies a batch of Search & Replace edits directly to the physical file system.
 */
export async function applySREditBatchFS(
  edits: AgentSREdit[],
  workspacePath: string,
): Promise<BatchPatchApplyResult> {
  const results: BatchPatchApplyItemResult[] = [];

  // Group edits by file
  const editsByFile = new Map<string, AgentSREdit[]>();
  for (const edit of edits) {
    if (!editsByFile.has(edit.file)) editsByFile.set(edit.file, []);
    editsByFile.get(edit.file)!.push(edit);
  }

  let allSuccess = true;

  for (const [file, fileEdits] of editsByFile.entries()) {
    const absPath = path.join(workspacePath, file);
    try {
      const text = await fs.readFile(absPath, "utf-8");

      // Idempotent apply: the agent tool-loop now persists validated edits on-green, so by
      // the time this final apply runs the file may already equal the target (a single
      // whole-file rewrite). Report it as applied — not a search-mismatch failure — so
      // diffs/counts stay correct and re-applying an already-applied edit is a safe no-op.
      if (fileEdits.length === 1 && text === fileEdits[0].replace) {
        results.push({ file, applied: true, skipped: false, validationErrors: [] });
        continue;
      }

      const res = applyFileEdits(text, fileEdits);

      if (!res.success) {
        results.push({
          file,
          applied: false,
          skipped: false,
          validationErrors: [res.error!],
        });
        allSuccess = false;
        continue;
      }

      await fs.writeFile(absPath, res.newContent!, "utf-8");

      // Verification: compare file hash before/after to detect no-op writes
      // (simpler than string matching which breaks with multi-edit context changes)
      const verifyContent = await fs.readFile(absPath, "utf-8");

      if (verifyContent === text) {
        // File unchanged after write - edit was a no-op (likely search mismatch that applyFileEdits missed)
        results.push({
          file,
          applied: false,
          skipped: false,
          validationErrors: [
            `⚠️ Edit verification failed: file content unchanged after write. ` +
            `The edit may not have matched the file. Use rewrite_file instead.`
          ],
        });
        allSuccess = false;
      } else {
        results.push({
          file,
          applied: true,
          skipped: false,
          validationErrors: [],
        });
      }
    } catch (err) {
      allSuccess = false;
      results.push({
        file,
        applied: false,
        skipped: false,
        validationErrors: [`Failed to read/write file: ${err}`],
      });
    }
  }

  return {
    success: allSuccess,
    results,
  };
}

/**
 * Writes complete file contents directly to the filesystem (wholefile format).
 * Creates parent directories if they don't exist.
 */
export async function applyWholeFileBatchFS(
  edits: AgentWholeFileEdit[],
  workspacePath: string,
): Promise<BatchPatchApplyResult> {
  const results: BatchPatchApplyItemResult[] = [];
  let allSuccess = true;

  for (const edit of edits) {
    const absPath = path.join(workspacePath, edit.file);
    try {
      // Read original content before writing (for verification)
      let originalContent = "";
      try {
        originalContent = await fs.readFile(absPath, "utf-8");
      } catch {
        // File doesn't exist yet - that's OK for wholefile
      }

      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, edit.content, "utf-8");

      // Verification: re-read and confirm file changed
      const verifyContent = await fs.readFile(absPath, "utf-8");

      if (verifyContent === originalContent && originalContent !== "") {
        // File unchanged after write - the write was a no-op
        results.push({
          file: edit.file,
          applied: false,
          skipped: false,
          validationErrors: [
            `⚠️ Rewrite verification failed: file content unchanged after write. ` +
            `The file may be locked or the write failed silently.`
          ],
        });
        allSuccess = false;
      } else {
        results.push({
          file: edit.file,
          applied: true,
          skipped: false,
          validationErrors: [],
        });
      }
    } catch (err) {
      allSuccess = false;
      results.push({
        file: edit.file,
        applied: false,
        skipped: false,
        validationErrors: [`Failed to write file: ${err}`],
      });
    }
  }

  return { success: allSuccess, results };
}

/**
 * Creates a commit for already applied changes.
 */
export async function commitAppliedPatches(
  workspacePath: string,
  message: string,
  filePaths?: string[],
): Promise<{ committed: boolean; stdout: string; stderr: string }> {
  try {
    const addArgs = ["-C", workspacePath, "add"];
    if (filePaths && filePaths.length > 0) {
      addArgs.push("--", ...filePaths);
    } else {
      addArgs.push("-A");
    }
    await execFileAsync("git", addArgs);

    const { stdout, stderr } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "commit",
      "-m",
      message,
    ]);

    return { committed: true, stdout, stderr };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      committed: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "git commit failed",
    };
  }
}

/**
 * Applies a batch of file creations. Does not overwrite existing files.
 */
export async function applyCreateFileBatchFS(
  creates: Array<{ file: string; content: string }>,
  workspacePath: string,
): Promise<BatchPatchApplyResult> {
  const results: BatchPatchApplyItemResult[] = [];
  let allSuccess = true;
  for (const { file, content } of creates) {
    const absPath = path.join(workspacePath, file);
    try {
      // Check if file exists
      await fs
        .access(absPath)
        .then(() => {
          // File exists
          results.push({
            file,
            applied: false,
            skipped: false,
            validationErrors: ["File already exists, not overwritten."],
          });
          allSuccess = false;
        })
        .catch(async () => {
          // File does not exist, create it
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, content, "utf-8");
          results.push({
            file,
            applied: true,
            skipped: false,
            validationErrors: [],
          });
        });
    } catch (err) {
      allSuccess = false;
      results.push({
        file,
        applied: false,
        skipped: false,
        validationErrors: [
          `Failed to create file: ${err instanceof Error ? err.message : String(err)}`,
        ],
      });
    }
  }
  return { success: allSuccess, results };
}
