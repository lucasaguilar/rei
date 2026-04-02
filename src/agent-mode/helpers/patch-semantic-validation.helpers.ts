import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { AgentLogger } from "../../core/logger.js";
import { supportsSemanticValidationPath } from "../../language/language-capabilities.js";
import { validateTypeScriptPatchAst } from "../../tools/typescript-ast-validator.js";
import {
  validatePatchProposal,
  type PatchProposalValidationResult,
} from "../../tools/patch-validator.js";

export async function validateWithAstGuard(
  proposal: AgentProposedPatch,
  workspacePath: string,
  logger?: AgentLogger,
): Promise<PatchProposalValidationResult> {
  const validation = await validatePatchProposal(proposal, workspacePath);
  if (!validation.valid) {
    return validation;
  }

  if (!supportsSemanticValidationPath(proposal.file)) {
    return validation;
  }

  const astResult = await validateTypeScriptPatchAst(
    proposal.patch,
    proposal.file,
    workspacePath,
  );
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
