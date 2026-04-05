import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { AgentLogger } from "../../core/logger.js";
import { supportsSemanticValidationPath } from "../../language/language-capabilities.js";
import {
  validateTypeScriptPatchAst,
  type AstValidationOptions,
} from "../../tools/typescript-ast-validator.js";
import {
  validatePatchProposal,
  type PatchProposalValidationResult,
} from "../../tools/patch-validator.js";

export async function validateWithAstGuard(
  proposal: AgentProposedPatch,
  workspacePath: string,
  logger?: AgentLogger,
  astOptions?: AstValidationOptions,
): Promise<PatchProposalValidationResult> {
  const validation = await validatePatchProposal(proposal, workspacePath);
  if (!validation.valid) {
    return validation;
  }

  if (!supportsSemanticValidationPath(proposal.file)) {
    return validation;
  }

  // Use pre-computed batch result when available (more accurate: cross-file types resolved).
  const batchResult = astOptions?.batchResults?.get(proposal.file);
  const astResult =
    batchResult ??
    (await validateTypeScriptPatchAst(
      proposal.patch,
      proposal.file,
      workspacePath,
      astOptions,
    ));

  if (!astResult.valid) {
    validation.valid = false;
    validation.issues.push({
      code: "AST_VALIDATION_FAILED" as any,
      message: `Compiler validation failed:\n${astResult.errors.join("\n")}`,
    });
    logger?.logCriticLoop(proposal.file, astResult.errors);
  }

  return validation;
}
