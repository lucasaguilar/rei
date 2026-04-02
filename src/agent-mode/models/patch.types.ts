import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { PatchProposalValidationResult } from "../../tools/patch-validator.js";

export interface PatchValidationEntry {
  proposal: AgentProposedPatch;
  validation: PatchProposalValidationResult;
}

export interface SearchReplaceBlock {
  file: string;
  description: string;
  search: string;
  replace: string;
}
