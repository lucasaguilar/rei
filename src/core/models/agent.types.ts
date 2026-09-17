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
  /** Frontend-provided elicitation (ask_user tool). CLI passes an interactive renderer; server/
   *  headless omits it → the dispatch uses the non-interactive safe default. */
  elicit?: import("../../chat/elicitation.js").ElicitFn;
  /** Hands the running turn whatever the user typed while it worked (the CLI queue). */
  drainUserMessages?: () => string[];
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
