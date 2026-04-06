import type { ChatSession } from "../../chat/types.js";
import type {
  AgentDecision,
  AgentProposedPatch,
} from "../../contracts/agent-decision.types.js";
import type {
  PatchSynthesisCoverage,
  PatchValidationEntry,
} from "./patch.types.js";
import type { SandboxVerificationResult } from "../helpers/sandbox-verification.helpers.js";

export interface AgentModeOutcome {
  response: string;
  validProposedPatches: AgentProposedPatch[];
}

export interface AgentContextPrelude {
  answerMessages: ChatSession["messages"];
  patchValidation: PatchValidationEntry[];
  decision: AgentDecision;
  synthesisCoverage?: PatchSynthesisCoverage;
  sandboxVerification?: SandboxVerificationResult;
}
