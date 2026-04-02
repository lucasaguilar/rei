import type { ChatSession } from "../../chat/types.js";
import type {
  AgentDecision,
  AgentProposedPatch,
} from "../../contracts/agent-decision.types.js";
import type { PatchValidationEntry } from "./patch.types.js";

export interface AgentModeOutcome {
  response: string;
  validProposedPatches: AgentProposedPatch[];
}

export interface AgentContextPrelude {
  answerMessages: ChatSession["messages"];
  patchValidation: PatchValidationEntry[];
  decision: AgentDecision;
}
