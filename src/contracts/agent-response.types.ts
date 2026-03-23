/**
 * Strict TypeScript contract for structured responses in AGENT mode.
 *
 * When REI is in agent mode, responses should conform to this shape so that
 * the CLI and future tooling can reliably parse and act on the output.
 *
 * Note: The JSON contract is enforced programmatically here in TypeScript.
 * The prose description lives in prompts/modes/agent.md.
 */

export interface AgentContextRequest {
  /** The file or resource path that is needed. */
  path: string;
  /** Why this context is required to proceed. */
  reason: string;
}

export interface AgentAction {
  /** Type of action: inspect (read), modify (write/patch), or validate (test/check). */
  type: "inspect" | "modify" | "validate";
  /** Target file or resource for the action. */
  target: string;
  /** Short description of what the action does. */
  description: string;
}

export interface AgentProposedChange {
  /** Target file path relative to the workspace root. */
  file: string;
  /** Human-readable description of the proposed change. */
  description: string;
}

export interface AgentRisk {
  /** Short label for the risk. */
  label: string;
  /** Explanation of why this is a risk and how to mitigate it. */
  detail: string;
}

export interface AgentResponse {
  /** Schema version for forward compatibility. */
  version: "1.0";
  /** The active session mode (always "agent" for this contract). */
  mode: "agent";
  /** One-sentence summary of what the agent understood the task to be. */
  summary: string;
  /**
   * Confidence level in the proposed plan, 0–1.
   * Low confidence means context is insufficient for a reliable answer.
   */
  confidence: number;
  /** Whether the agent needs more repository context before it can proceed. */
  needsMoreContext: boolean;
  /** Specific context requests when needsMoreContext is true. */
  contextRequests: AgentContextRequest[];
  /** Actions the agent would perform (inspect / modify / validate). */
  actions: AgentAction[];
  /** Concrete changes proposed for the repository (preview-first: described, not applied). */
  proposedChanges: AgentProposedChange[];
  /** Risks or concerns about the proposed plan. */
  risks: AgentRisk[];
  /** Final human-readable message to display to the user. */
  finalMessage: string;
}

/**
 * Returns a formatted JSON contract block suitable for injection into the
 * system prompt so the model knows the expected output structure.
 *
 * This is intentionally built in TypeScript (not only described in markdown)
 * to keep the contract machine-verifiable and easy to evolve.
 */
export function buildAgentContractBlock(): string {
  const example: AgentResponse = {
    version: "1.0",
    mode: "agent",
    summary: "<one-sentence summary of the understood task>",
    confidence: 0.9,
    needsMoreContext: false,
    contextRequests: [],
    actions: [
      { type: "inspect", target: "<file>", description: "<what to look for>" },
    ],
    proposedChanges: [
      { file: "<file>", description: "<what would change and why>" },
    ],
    risks: [
      { label: "<risk label>", detail: "<explanation and mitigation>" },
    ],
    finalMessage: "<message to the user>",
  };

  return [
    "AGENT MODE OUTPUT RULES (these override all general response rules):",
    "- Your entire response must be a single raw JSON object. No text before it, no text after it.",
    "- Do NOT use markdown fences (no ```json). Output raw JSON only.",
    "- Do NOT greet, explain, or summarize in prose. JSON is the only valid output.",
    "",
    "The JSON object must conform to this exact shape:",
    JSON.stringify(example, null, 2),
    "",
    "Additional rules:",
    "- Omit fields that do not apply (e.g. omit contextRequests when needsMoreContext is false).",
    "- Do not add fields outside this contract.",
    "- confidence must be a number between 0 and 1.",
    "- All file paths must be relative to the workspace root.",
  ].join("\n");
}
