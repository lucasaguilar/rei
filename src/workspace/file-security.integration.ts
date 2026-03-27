/**
 * Integration example: How file-security.ts will be used in patch workflow.
 *
 * This file documents the security layer integration for Phase 1 (Security).
 * When Phases 2-6 are implemented, this logic flows into patch validation.
 */

import {
  validateFileTarget,
  isWithinWorkspace,
  DEFAULT_FILE_MODIFY_POLICY,
  describeValidationError,
  type FileModifyPolicy,
} from "./file-security.js";

/**
 * Example 1: Validating a file from an AgentDecision proposedPatch.
 *
 * When Phase 5 extends AgentDecision to include proposedPatches, each patch
 * will need to validate its target file BEFORE attempting to apply it.
 */
export function validatePatchTargetFile(
  patchFilePath: string,
  workspacePath: string,
  policy: FileModifyPolicy = DEFAULT_FILE_MODIFY_POLICY
): { valid: boolean; reason?: string } {
  const result = validateFileTarget(patchFilePath, workspacePath, policy);
  
  if (!result.ok) {
    return {
      valid: false,
      reason: `${describeValidationError(result.error)}: "${patchFilePath}"`,
    };
  }

  return { valid: true };
}

/**
 * Example 2: Batch validation of multiple patches.
 *
 * Phase 6 (CLI confirmation gate) will validate all patches at once
 * before showing them to the user and requesting confirmation.
 */
export function validateAllPatchTargets(
  patches: Array<{ file: string; description: string; patch: string }>,
  workspacePath: string,
  policy: FileModifyPolicy = DEFAULT_FILE_MODIFY_POLICY
): Array<{ file: string; valid: boolean; reason?: string }> {
  return patches.map((p) => ({
    file: p.file,
    ...validatePatchTargetFile(p.file, workspacePath, policy),
  }));
}

/**
 * Example 3: Policy customization for specific workflows.
 *
 * Teams can define stricter or looser policies:
 *   - Strict: only src/domain/*, require validation for all
 *   - Lenient: allow docs/* + prompts/*, skip symlink checks
 */
export function createCustomPolicy(overrides: Partial<FileModifyPolicy>): FileModifyPolicy {
  return {
    ...DEFAULT_FILE_MODIFY_POLICY,
    ...overrides,
  };
}

/**
 * Example 4: Pre-flight check before accepting user patch proposal.
 *
 * When a user provides a patch via `/patch` command or suggestion,
 * immediately validate the target file before storing the patch.
 */
export function preflight(
  filePath: string,
  workspacePath: string
): { ok: boolean; reason?: string; safeToModify: boolean } {
  const validation = validateFileTarget(filePath, workspacePath);

  if (!validation.ok) {
    return {
      ok: false,
      reason: describeValidationError(validation.error),
      safeToModify: false,
    };
  }

  // Additional checks could go here (file size, encoding, etc.)
  return {
    ok: true,
    safeToModify: true,
  };
}
