import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { PatchProposal } from "./patch-validator.js";
import { validatePatchProposal } from "./patch-validator.js";

const execFileAsync = promisify(execFile);

export interface PatchApplyOptions {
  dryRun?: boolean;
}

export interface PatchApplyResult {
  applied: boolean;
  stdout: string;
  stderr: string;
}

export interface BatchPatchApplyItemResult {
  file: string;
  applied: boolean;
  skipped: boolean;
  validationErrors: string[];
  stdout: string;
  stderr: string;
}

export interface BatchPatchApplyResult {
  success: boolean;
  dryRun: boolean;
  results: BatchPatchApplyItemResult[];
}

/**
 * Apply a unified diff patch through git apply.
 * Uses --check in dryRun mode for safe preflight.
 */
export async function applyPatchToFS(
  patchText: string,
  workspacePath: string,
  options: PatchApplyOptions = {}
): Promise<PatchApplyResult> {
  const dryRun = options.dryRun ?? true;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rei-patch-apply-"));
  const patchPath = path.join(tmpDir, "apply.patch");

  try {
    await fs.writeFile(patchPath, patchText, "utf-8");

    const args = ["-C", workspacePath, "apply"];
    if (dryRun) args.push("--check");
    args.push("--whitespace=nowarn", patchPath);

    const { stdout, stderr } = await execFileAsync("git", args);
    return { applied: true, stdout, stderr };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      applied: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "git apply failed",
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Validate + apply multiple patch proposals in sequence.
 * By default this runs in dry-run mode.
 */
export async function applyPatchBatch(
  proposals: PatchProposal[],
  workspacePath: string,
  options: PatchApplyOptions = {}
): Promise<BatchPatchApplyResult> {
  const dryRun = options.dryRun ?? true;
  const results: BatchPatchApplyItemResult[] = [];

  for (const proposal of proposals) {
    const validation = await validatePatchProposal(proposal, workspacePath);

    if (!validation.valid) {
      results.push({
        file: proposal.file,
        applied: false,
        skipped: true,
        validationErrors: validation.issues.map((issue) => issue.message),
        stdout: validation.git.stdout,
        stderr: validation.git.stderr,
      });
      continue;
    }

    const applied = await applyPatchToFS(proposal.patch, workspacePath, { dryRun });
    results.push({
      file: proposal.file,
      applied: applied.applied,
      skipped: false,
      validationErrors: [],
      stdout: applied.stdout,
      stderr: applied.stderr,
    });
  }

  return {
    success: results.every((item) => item.applied || item.skipped),
    dryRun,
    results,
  };
}

/**
 * Create a commit for already applied patch changes.
 * This function only handles commit orchestration, not patch application.
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
