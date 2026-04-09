import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
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
      const res = applyFileEdits(text, fileEdits);
      
      if (!res.success) {
        results.push({
          file,
          applied: false,
          skipped: false,
          validationErrors: [res.error!]
        });
        allSuccess = false;
        continue;
      }
      
      await fs.writeFile(absPath, res.newContent!, "utf-8");
      
      results.push({
        file,
        applied: true,
        skipped: false,
        validationErrors: []
      });
      
    } catch (err) {
      allSuccess = false;
      results.push({
        file,
        applied: false,
        skipped: false,
        validationErrors: [`Failed to read/write file: ${err}`]
      });
    }
  }

  return {
    success: allSuccess,
    results,
  };
}

/**
 * Creates a commit for already applied changes.
 */
export async function commitAppliedPatches(
  workspacePath: string,
  message: string,
  filePaths?: string[]
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
