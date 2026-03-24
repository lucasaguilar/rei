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
  /**
   * A clear, technical description of what should be changed, including:
   * - intent
   * - approximate location
   * - constraints
   * Exact code is optional and should be avoided unless trivial.
   */
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
  /**
   * Proposed repository changes for agent-mode preview (described, not applied),
   * each including target file, intent, approximate location, and constraints.
   * Agent mode operates preview-first — no actual file writes are performed at this stage.
   */
  proposedChanges: AgentProposedChange[];
  /** Risks or concerns about the proposed plan. */
  risks: AgentRisk[];
  /** Final human-readable message to display to the user. */
  finalMessage: string;
}

type JsonRecord = Record<string, unknown>;

const AGENT_RESPONSE_KEYS = [
  "version",
  "mode",
  "summary",
  "confidence",
  "needsMoreContext",
  "contextRequests",
  "actions",
  "proposedChanges",
  "risks",
  "finalMessage",
] as const;

const AGENT_CONTEXT_REQUEST_KEYS = ["path", "reason"] as const;
const AGENT_ACTION_KEYS = ["type", "target", "description"] as const;
const AGENT_PROPOSED_CHANGE_KEYS = ["file", "description"] as const;
const AGENT_RISK_KEYS = ["label", "detail"] as const;

const ACTION_TYPE_ALIASES: Record<string, AgentAction["type"]> = {
  inspect: "inspect",
  analyze: "inspect",
  analysis: "inspect",
  read: "inspect",
  review: "inspect",
  explore: "inspect",
  investigate: "inspect",
  check: "validate",
  validate: "validate",
  verification: "validate",
  verify: "validate",
  test: "validate",
  testing: "validate",
  run: "validate",
  modify: "modify",
  edit: "modify",
  update: "modify",
  write: "modify",
  patch: "modify",
  change: "modify",
  fix: "modify",
  add: "modify",
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertExactKeys(
  value: JsonRecord,
  allowedKeys: readonly string[],
  path: string
): void {
  for (const key of Object.keys(value)) {
    assert(
      allowedKeys.includes(key),
      `Invalid AGENT mode response: unexpected field ${path}.${key}`
    );
  }

  for (const key of allowedKeys) {
    assert(key in value, `Invalid AGENT mode response: missing field ${path}.${key}`);
  }
}

function expectString(value: unknown, path: string): string {
  assert(typeof value === "string", `Invalid AGENT mode response: ${path} must be a string`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  assert(typeof value === "boolean", `Invalid AGENT mode response: ${path} must be a boolean`);
  return value;
}

function expectNumber(value: unknown, path: string): number {
  assert(typeof value === "number", `Invalid AGENT mode response: ${path} must be a number`);
  return value;
}

function validateContextRequest(value: unknown, path: string): AgentContextRequest {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  assertExactKeys(value, AGENT_CONTEXT_REQUEST_KEYS, path);
  return {
    path: expectString(value.path, `${path}.path`),
    reason: expectString(value.reason, `${path}.reason`),
  };
}

function validateAction(value: unknown, path: string): AgentAction {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  assertExactKeys(value, AGENT_ACTION_KEYS, path);

  const rawType = expectString(value.type, `${path}.type`);
  const type = ACTION_TYPE_ALIASES[rawType.toLowerCase()];
  assert(
    type === "inspect" || type === "modify" || type === "validate",
    `Invalid AGENT mode response: ${path}.type must be inspect, modify, or validate`
  );

  return {
    type,
    target: expectString(value.target, `${path}.target`),
    description: expectString(value.description, `${path}.description`),
  };
}

function validateProposedChange(value: unknown, path: string): AgentProposedChange {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  assertExactKeys(value, AGENT_PROPOSED_CHANGE_KEYS, path);
  return {
    file: expectString(value.file, `${path}.file`),
    description: expectString(value.description, `${path}.description`),
  };
}

function validateRisk(value: unknown, path: string): AgentRisk {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  assertExactKeys(value, AGENT_RISK_KEYS, path);
  return {
    label: expectString(value.label, `${path}.label`),
    detail: expectString(value.detail, `${path}.detail`),
  };
}

function expectArray(value: unknown, path: string): unknown[] {
  assert(Array.isArray(value), `Invalid AGENT mode response: ${path} must be an array`);
  return value;
}

export function validateAgentResponse(value: unknown): AgentResponse {
  assert(isRecord(value), "Invalid AGENT mode response: root value must be an object");
  assertExactKeys(value, AGENT_RESPONSE_KEYS, "response");

  const version = expectString(value.version, "response.version");
  assert(version === "1.0", 'Invalid AGENT mode response: response.version must be "1.0"');

  const mode = expectString(value.mode, "response.mode");
  assert(mode === "agent", 'Invalid AGENT mode response: response.mode must be "agent"');

  const confidence = expectNumber(value.confidence, "response.confidence");
  assert(
    confidence >= 0 && confidence <= 1,
    "Invalid AGENT mode response: response.confidence must be between 0 and 1"
  );

  return {
    version,
    mode,
    summary: expectString(value.summary, "response.summary"),
    confidence,
    needsMoreContext: expectBoolean(value.needsMoreContext, "response.needsMoreContext"),
    contextRequests: expectArray(value.contextRequests, "response.contextRequests").map(
      (item, index) => validateContextRequest(item, `response.contextRequests[${index}]`)
    ),
    actions: expectArray(value.actions, "response.actions").map((item, index) =>
      validateAction(item, `response.actions[${index}]`)
    ),
    proposedChanges: expectArray(
      value.proposedChanges,
      "response.proposedChanges"
    ).map((item, index) =>
      validateProposedChange(item, `response.proposedChanges[${index}]`)
    ),
    risks: expectArray(value.risks, "response.risks").map((item, index) =>
      validateRisk(item, `response.risks[${index}]`)
    ),
    finalMessage: expectString(value.finalMessage, "response.finalMessage"),
  };
}

export function parseAgentResponse(raw: string): AgentResponse {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid AGENT mode response: response is not valid JSON (${message})`);
  }

  return validateAgentResponse(parsed);
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
    "- All fields in the example object must be present. Use empty arrays for lists that do not apply (e.g. contextRequests when needsMoreContext is false).",
    "- Do not add fields outside this contract.",
    "- For actions.type, use only inspect, modify, or validate. Do not invent synonyms like analyze, review, edit, or test.",
    "- If you want to suggest a next step, put it inside finalMessage or an existing description field. Never create fields like nextStep.",
    "- confidence must be a number between 0 and 1.",
    "- All file paths must be relative to the workspace root.",
  ].join("\n");
}
