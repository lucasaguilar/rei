import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { PatchProposalValidationResult } from "../../tools/patch-validator.js";

export interface PatchValidationEntry {
  proposal: AgentProposedPatch;
  validation: PatchProposalValidationResult;
}

export type SynthesizedEditDropReason =
  | "SEARCH_NOT_FOUND"
  | "SEARCH_AMBIGUOUS"
  | "CREATE_TARGET_EXISTS"
  | "EMPTY_PATCH_RESULT";

export interface SynthesizedEditDrop {
  file: string;
  description: string;
  reason: SynthesizedEditDropReason;
  detail?: string;
}

export interface PatchSynthesisCoverage {
  rawEditCount: number;
  acceptedEditCount: number;
  patchCount: number;
  droppedEdits: SynthesizedEditDrop[];
}

export interface SearchReplaceBlock {
  file: string;
  description: string;
  search: string;
  replace: string;
  /** Create-file edit mode. */
  create?: boolean;
  /** Full content for create-file mode. */
  content?: string;
}
