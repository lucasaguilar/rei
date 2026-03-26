/**
 * Internal contract for the AGENT mode context-evaluation phase (Phase 1).
 *
 * This is a lightweight schema used only to decide whether the model needs
 * additional file context before generating its final answer.
 * It is never shown to the user.
 */

export interface AgentContextRequest {
  /** Workspace-relative path to the file needed. */
  path: string;
  /** Why this file is needed to answer the request. */
  reason: string;
}

export type AgentTaskType = "inspection" | "change-planning";

export interface AgentDecision {
  /** Whether the model can answer with the currently-visible context. */
  ready: boolean;
  /** inspection = explain/show/analyze; change-planning = implement/modify/fix */
  taskType: AgentTaskType;
  /** Files to read fully when ready is false. Must be empty when ready is true. */
  contextRequests: AgentContextRequest[];
}

export function parseAgentDecision(raw: string): AgentDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AgentDecision: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AgentDecision: expected a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.ready !== "boolean") {
    // Tolerate string "true"/"false" from lenient models.
    if (obj.ready === "true") {
      obj.ready = true;
    } else if (obj.ready === "false") {
      obj.ready = false;
    } else {
      throw new Error(`AgentDecision: 'ready' must be boolean, got ${typeof obj.ready}`);
    }
  }

  if (obj.taskType !== "inspection" && obj.taskType !== "change-planning") {
    // Tolerate common alias variations.
    const raw = String(obj.taskType ?? "").toLowerCase();
    if (raw.includes("inspect") || raw.includes("analys") || raw.includes("explain")) {
      obj.taskType = "inspection";
    } else if (raw.includes("change") || raw.includes("plan") || raw.includes("implement")) {
      obj.taskType = "change-planning";
    } else {
      // Default to inspection rather than reject — less disruptive.
      obj.taskType = "inspection";
    }
  }

  const contextRequests: AgentContextRequest[] = [];
  if (Array.isArray(obj.contextRequests)) {
    for (const item of obj.contextRequests) {
      if (typeof item === "object" && item !== null) {
        const r = item as Record<string, unknown>;
        // Accept "file" as alias for "path".
        const p = typeof r.path === "string" ? r.path : (typeof r.file === "string" ? r.file : "");
        if (p) {
          contextRequests.push({
            path: p,
            reason: typeof r.reason === "string" ? r.reason : "",
          });
        }
      }
    }
  }

  return {
    ready: obj.ready as boolean,
    taskType: obj.taskType as AgentTaskType,
    contextRequests,
  };
}
