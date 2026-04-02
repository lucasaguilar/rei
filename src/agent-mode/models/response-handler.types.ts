import type { AgentResponse } from "../../contracts/agent-response.types.js";

export type ParseRecoveryStage = "direct" | "sanitized" | "repaired";

export interface ParseRecoveryResult {
  response: AgentResponse;
  stage: ParseRecoveryStage;
}
