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
const AGENT_ACTION_COMPAT_KEYS = ["type", "target", "description", "value"] as const;
const AGENT_ACTION_COMPAT_KEY_SET = new Set<string>(AGENT_ACTION_COMPAT_KEYS);
const AGENT_PROPOSED_CHANGE_KEYS = ["file", "description"] as const;
const AGENT_RISK_KEYS = ["label", "detail"] as const;

/**
 * Top-level fields the model commonly adds on its own that have no meaning in
 * the contract. They are silently stripped before structural validation so they
 * do not trigger a retry loop.
 */
const AGENT_RESPONSE_IGNORED_KEYS = new Set([
  "nextStep",
  "next_step",
  "notes",
  "rationale",
  "reasoning",
  "thinking",
  "metadata",
  "thought",
  "plan",
]);

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

/**
 * Only checks that the required keys are present; silently ignores any extra
 * fields the model may add. Used for sub-objects where strict shape enforcement
 * would cause too many spurious validation failures.
 */
function requireKeys(
  value: JsonRecord,
  requiredKeys: readonly string[],
  path: string
): void {
  for (const key of requiredKeys) {
    assert(key in value, `Invalid AGENT mode response: missing field ${path}.${key}`);
  }
}

function expectString(value: unknown, path: string): string {
  assert(typeof value === "string", `Invalid AGENT mode response: ${path} must be a string`);
  assert(
    !/^<.+>$/.test((value as string).trim()),
    `Invalid AGENT mode response: ${path} contains an unfilled template placeholder`
  );
  return value as string;
}

function expectRelativeWorkspacePath(value: unknown, path: string): string {
  const raw = expectString(value, path).trim();
  assert(raw.length > 0, `Invalid AGENT mode response: ${path} must not be empty`);

  const hasUriScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw);
  const isUnixAbsolute = raw.startsWith("/");

  assert(
    !hasUriScheme && !isWindowsAbsolute && !isUnixAbsolute,
    `Invalid AGENT mode response: ${path} must be a workspace-relative path`
  );

  // Disallow directory traversal segments to ensure the path is truly workspace-root-relative.
  const segments = raw.split(/[\\/]+/);
  assert(
    !segments.includes(".."),
    `Invalid AGENT mode response: ${path} must not contain ".." path traversal segments`
  );
  return raw;
}

function expectLiteral<T extends string>(
  value: unknown,
  literal: T,
  path: string
): T {
  assert(
    typeof value === "string" && value === literal,
    `Invalid AGENT mode response: ${path} must be "${literal}"`
  );
  return value as T;
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
  // Accept "file" as an alias for "path" (common model substitution).
  const normalized: JsonRecord =
    !("path" in value) && "file" in value
      ? { ...value, path: value.file }
      : value;
  assert("path" in normalized, `Invalid AGENT mode response: missing field ${path}.path`);
  return {
    path: expectRelativeWorkspacePath(normalized.path, `${path}.path`),
    // "reason" is required by the contract but tolerated as absent to avoid spurious retries.
    reason: typeof normalized.reason === "string" ? normalized.reason : "",
  };
}

function validateAction(value: unknown, path: string): AgentAction {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  for (const key of Object.keys(value)) {
    assert(
      AGENT_ACTION_COMPAT_KEY_SET.has(key),
      `Invalid AGENT mode response: unexpected field ${path}.${key}`
    );
  }
  assert(
    "type" in value && "target" in value,
    `Invalid AGENT mode response: missing field ${path}.${!("type" in value) ? "type" : "target"}`
  );
  assert(
    "description" in value || "value" in value,
    `Invalid AGENT mode response: missing field ${path}.description`
  );

  const rawType = expectString(value.type, `${path}.type`);
  const type = ACTION_TYPE_ALIASES[rawType.toLowerCase()];
  assert(
    type === "inspect" || type === "modify" || type === "validate",
    `Invalid AGENT mode response: ${path}.type must be inspect, modify, or validate`
  );

  const descriptionCandidate =
    typeof value.description === "string"
      ? value.description
      : expectString(value.value, `${path}.value`);

  return {
    type,
    target: expectRelativeWorkspacePath(value.target, `${path}.target`),
    description: descriptionCandidate,
  };
}

function validateProposedChange(value: unknown, path: string): AgentProposedChange {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  requireKeys(value, AGENT_PROPOSED_CHANGE_KEYS, path);
  return {
    file: expectRelativeWorkspacePath(value.file, `${path}.file`),
    description: expectString(value.description, `${path}.description`),
  };
}

function validateRisk(value: unknown, path: string): AgentRisk {
  assert(isRecord(value), `Invalid AGENT mode response: ${path} must be an object`);
  requireKeys(value, AGENT_RISK_KEYS, path);
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

  // Strip silently-ignored extra fields the model may add (e.g. nextStep, notes).
  const stripped: JsonRecord = Object.fromEntries(
    Object.entries(value).filter(([k]) => !AGENT_RESPONSE_IGNORED_KEYS.has(k))
  );
  assertExactKeys(stripped, AGENT_RESPONSE_KEYS, "response");

  const version = expectLiteral(value.version, "1.0" as const, "response.version");
  const mode = expectLiteral(value.mode, "agent" as const, "response.mode");

  const confidence = expectNumber(value.confidence, "response.confidence");
  assert(
    confidence >= 0 && confidence <= 1,
    "Invalid AGENT mode response: response.confidence must be between 0 and 1"
  );

  const needsMoreContext = expectBoolean(value.needsMoreContext, "response.needsMoreContext");

  return {
    version,
    mode,
    summary: expectString(value.summary, "response.summary"),
    confidence,
    needsMoreContext,
    // When needsMoreContext is false the model should send an empty array but
    // sometimes sends a malformed one. Ignore the contents in that case.
    contextRequests: needsMoreContext
      ? expectArray(value.contextRequests, "response.contextRequests").map(
          (item, index) => validateContextRequest(item, `response.contextRequests[${index}]`)
        )
      : [],
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
  // NOTE: all values here are deliberately unrelated to any real code task.
  // They exist only to show the JSON structure — the model must NOT copy them.
  const example: AgentResponse = {
    version: "1.0",
    mode: "agent",
    summary: "Propose to inspect the project README to verify the installation steps.",
    confidence: 0.85,
    needsMoreContext: false,
    contextRequests: [],
    actions: [
      { type: "inspect", target: "README.md", description: "Read the installation section to verify the steps are complete" },
    ],
    proposedChanges: [],
    risks: [
      { label: "outdated documentation", detail: "The README may not reflect recent dependency changes; cross-check with package.json" },
    ],
    finalMessage: "Propose to review README.md to confirm the installation steps are up to date.",
  };

  return [
    "AGENT MODE OUTPUT RULES (these override all general response rules):",
    "- Your entire response must be a single raw JSON object. No text before it, no text after it.",
    "- Do NOT use markdown fences (no ```json). Output raw JSON only.",
    "- Do NOT greet, explain, or summarize in prose. JSON is the only valid output.",
    "",
    "The JSON object must conform to this exact shape (STRUCTURAL EXAMPLE ONLY — all values below are FICTIONAL and unrelated to your task):",
    JSON.stringify(example, null, 2),
    "",
    "IMPORTANT: Do NOT copy any value from the structural example above into your response.",
    "Replace every string, number, and path with content that reflects the ACTUAL user task.",
    "Copying example values verbatim (e.g. \"Propose to add a console.log...\") is always wrong.",
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
