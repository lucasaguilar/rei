import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";

export type TurnStatus =
  | "building_context"
  | "fetching_external_knowledge"
  | "calling_model"
  | "producing_response"
  | "compacting_memory";

export type StreamTurnOptions = {
  onStatus?: (status: TurnStatus) => void;
};

export interface PendingPatchAssessmentItem {
  proposal: AgentProposedPatch;
  applicable: boolean;
  safe: boolean;
  issues: string[];
}

export interface PendingPatchAssessment {
  workspaceQualityOk: boolean;
  workspaceQualityStderr: string;
  items: PendingPatchAssessmentItem[];
}
