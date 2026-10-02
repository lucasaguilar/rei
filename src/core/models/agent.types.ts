import type { AgentSREdit } from "../../contracts/agent-interaction.types.js";

export type TurnStatus =
  | "building_context"
  | "fetching_external_knowledge"
  | "calling_model"
  | "producing_response"
  | "compacting_memory"
  // Not a phase but an EVENT: the history just shrank. The CLI republishes the context gauge on it
  // — the reading it is showing was measured before the compaction and is now stale, and a turn
  // can run for minutes before its end-of-turn reading would have corrected it.
  | "memory_compacted"
  | "indexing_repository"
  | "checking_hardware";

export type StreamTurnOptions = {
  onStatus?: (status: TurnStatus) => void;
  /** Frontend-provided elicitation (ask_user tool). CLI passes an interactive renderer; server/
   *  headless omits it → the dispatch uses the non-interactive safe default. */
  elicit?: import("../../chat/elicitation.js").ElicitFn;
  /** Hands the running turn whatever the user typed while it worked (the CLI queue). */
  drainUserMessages?: () => string[];
  /** Restricts the turn to these tool names — offered AND executed; everything else (MCP,
   *  web_search, run_command…) is neither. For channels with nobody at the keyboard: `ask` alone
   *  is not read-only, it includes run_command. Unset = the mode's full set. */
  allowedTools?: readonly string[];
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
