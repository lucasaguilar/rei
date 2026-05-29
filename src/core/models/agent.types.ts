import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";

export type TurnStatus =
  | "building_context"
  | "fetching_external_knowledge"
  | "calling_model"
  | "producing_response"
  | "compacting_memory"
  | "indexing_repository"
  | "checking_hardware";

export type StreamTurnOptions = {
  onStatus?: (status: TurnStatus) => void;
};

export interface PendingPatchAssessmentItem {
  proposal: AgentSREdit;
  applicable: boolean;
  safe: boolean;
  issues: string[];
}

export interface PendingPatchAssessment {
  workspaceQualityOk: boolean;
  workspaceQualityStderr: string;
  items: PendingPatchAssessmentItem[];
}
