import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  validateFileTarget,
  describeValidationError,
  type FileModifyPolicy,
  DEFAULT_FILE_MODIFY_POLICY,
} from "../workspace/file-security.js";
import { extractFileFromPatch } from "./patch-generator.js";

const execFileAsync = promisify(execFile);

export interface PatchValidationIssue {
  code:
    | "EMPTY_PATCH"
    | "INVALID_PATCH_HEADERS"
    | "MISSING_HUNKS"
    | "MULTI_FILE_PATCH_UNSUPPORTED"
    | "MERGE_CONFLICT_MARKER"
    | "TARGET_FILE_MISMATCH"
    | "SECURITY_POLICY"
    | "GIT_APPLY_CHECK_FAILED";
  message: string;
}

export interface PatchSemanticValidationResult {
  valid: boolean;
  file?: string;
  issues: PatchValidationIssue[];
}

export interface GitPatchValidationResult {
  valid: boolean;
  stdout: string;
  stderr: string;
}

export interface PatchProposal {
  file: string;
  description: string;
  patch: string;
}

export interface PatchProposalValidationResult {
  valid: boolean;
  file: string;
  issues: PatchValidationIssue[];
  semantic: PatchSemanticValidationResult;
  git: GitPatchValidationResult;
}

/**
 * Detect merge conflict markers in patch text.
 */
export function detectMergeConflicts(patchText: string): string[] {
  const conflictLines: string[] = [];
  const lines = patchText.split("\n");

  for (const line of lines) {
    if (
      line.startsWith("<<<<<<<") ||
      line.startsWith("=======") ||
      line.startsWith(">>>>>>>")
    ) {
      conflictLines.push(line);
    }
  }

  return conflictLines;
}

/**
 * Validate patch structure and extract target file metadata.
 */
export function validatePatchSemantics(
  patchText: string,
): PatchSemanticValidationResult {
  const issues: PatchValidationIssue[] = [];
  const trimmed = patchText.trim();

  if (!trimmed) {
    issues.push({
      code: "EMPTY_PATCH",
      message: "Patch is empty",
    });
    return { valid: false, issues };
  }

  const lines = patchText.split("\n");
  const oldHeaders = lines.filter((line) => line.startsWith("--- "));
  const newHeaders = lines.filter((line) => line.startsWith("+++ "));
  const hunkHeaders = lines.filter((line) => line.startsWith("@@"));

  if (oldHeaders.length !== 1 || newHeaders.length !== 1) {
    issues.push({
      code: "INVALID_PATCH_HEADERS",
      message: "Patch must contain exactly one file header pair (--- / +++)",
    });
  }

  if (oldHeaders.length > 1 || newHeaders.length > 1) {
    issues.push({
      code: "MULTI_FILE_PATCH_UNSUPPORTED",
      message: "Only single-file patches are supported in this phase",
    });
  }

  if (hunkHeaders.length < 1) {
    issues.push({
      code: "MISSING_HUNKS",
      message: "Patch must contain at least one hunk header (@@)",
    });
  }

  const conflicts = detectMergeConflicts(patchText);
  if (conflicts.length > 0) {
    issues.push({
      code: "MERGE_CONFLICT_MARKER",
      message: `Patch contains merge conflict markers (${conflicts.length})`,
    });
  }

  const extracted = extractFileFromPatch(patchText);
  if (!extracted) {
    issues.push({
      code: "INVALID_PATCH_HEADERS",
      message: "Could not extract file information from patch headers",
    });
    return { valid: false, issues };
  }

  return {
    valid: issues.length === 0,
    file: extracted.file,
    issues,
  };
}

/**
 * Validate patch applicability using git apply --check.
 */
export async function validatePatchWithGit(
  patchText: string,
  workspacePath: string,
): Promise<GitPatchValidationResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rei-patch-check-"));
  const patchPath = path.join(tmpDir, "candidate.patch");

  try {
    await fs.writeFile(patchPath, patchText, "utf-8");

    const { stdout, stderr } = await execFileAsync("git", [
      "-C",
      workspacePath,
      "apply",
      "--check",
      "--whitespace=nowarn",
      patchPath,
    ]);

    return { valid: true, stdout, stderr };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      valid: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "git apply --check failed",
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Validate a patch proposal end-to-end for Phase 3.
 */
export async function validatePatchProposal(
  proposal: PatchProposal,
  workspacePath: string,
  policy: FileModifyPolicy = DEFAULT_FILE_MODIFY_POLICY,
): Promise<PatchProposalValidationResult> {
  const semantic = validatePatchSemantics(proposal.patch);
  const issues: PatchValidationIssue[] = [...semantic.issues];
  const extractedInfo = extractFileFromPatch(proposal.patch);

  if (semantic.file && semantic.file !== proposal.file) {
    issues.push({
      code: "TARGET_FILE_MISMATCH",
      message: `Proposal file \"${proposal.file}\" does not match patch target \"${semantic.file}\"`,
    });
  }

  const fileForSecurity = semantic.file ?? proposal.file;
  const isCreatePatch = extractedInfo?.oldFile.trim() === "/dev/null";
  const security = validateFileTarget(fileForSecurity, workspacePath, policy, {
    allowCreate: isCreatePatch,
  });
  if (!security.ok) {
    issues.push({
      code: "SECURITY_POLICY",
      message: `${describeValidationError(security.error)}: ${security.error.path}`,
    });
  }

  const git =
    issues.length === 0
      ? await validatePatchWithGit(proposal.patch, workspacePath)
      : {
          valid: false,
          stdout: "",
          stderr: "Skipped git apply --check due to prior validation issues",
        };

  if (
    !git.valid &&
    issues.every((issue) => issue.code !== "GIT_APPLY_CHECK_FAILED")
  ) {
    issues.push({
      code: "GIT_APPLY_CHECK_FAILED",
      message: git.stderr || "git apply --check failed",
    });
  }

  return {
    valid: issues.length === 0,
    file: proposal.file,
    issues,
    semantic,
    git,
  };
}
