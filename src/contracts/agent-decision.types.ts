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

export interface AgentProposedPatch {
  /** Workspace-relative target file path. */
  file: string;
  /** Human-readable explanation of intent. */
  description: string;
  /** Unified diff patch text for this file. */
  patch: string;
}

export type AgentTaskType = "inspection" | "change-planning";

export interface AgentDecision {
  /** Whether the model can answer with the currently-visible context. */
  ready: boolean;
  /** inspection = explain/show/analyze; change-planning = implement/modify/fix */
  taskType: AgentTaskType;
  /** Files to read fully when ready is false. Must be empty when ready is true. */
  contextRequests: AgentContextRequest[];
  /** Optional patch proposals for change-planning tasks. */
  proposedPatches?: AgentProposedPatch[];
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
    const taskTypeRaw = String(obj.taskType ?? "").toLowerCase();
    if (taskTypeRaw.includes("inspect") || taskTypeRaw.includes("analys") || taskTypeRaw.includes("explain")) {
      obj.taskType = "inspection";
    } else if (taskTypeRaw.includes("change") || taskTypeRaw.includes("plan") || taskTypeRaw.includes("implement")) {
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

  let proposedPatches: AgentProposedPatch[] | undefined;
  const parsedPatches = parsePatchArray(obj.proposedPatches);
  const recoveredFromDuplicateKeys = extractDuplicateProposedPatchArrays(raw)
    .flatMap(parsePatchArray);

  const mergedPatches = dedupePatches([
    ...parsedPatches,
    ...recoveredFromDuplicateKeys,
  ]);

  if (mergedPatches.length > 0) {
    proposedPatches = mergedPatches;
  }

  return {
    ready: obj.ready as boolean,
    taskType: obj.taskType as AgentTaskType,
    contextRequests,
    ...(proposedPatches ? { proposedPatches } : {}),
  };
}

function parsePatchArray(value: unknown): AgentProposedPatch[] {
  if (!Array.isArray(value)) return [];

  const parsedPatches: AgentProposedPatch[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const patchObj = item as Record<string, unknown>;
    const file = typeof patchObj.file === "string" ? patchObj.file : "";
    const description =
      typeof patchObj.description === "string" ? patchObj.description : "";
    const patch = typeof patchObj.patch === "string" ? patchObj.patch : "";
    if (!file || !patch) continue;
    parsedPatches.push({ file, description, patch });
  }

  return parsedPatches;
}

function dedupePatches(
  patches: AgentProposedPatch[],
): AgentProposedPatch[] {
  const seen = new Set<string>();
  const deduped: AgentProposedPatch[] = [];

  for (const patch of patches) {
    const key = `${patch.file}\n${patch.patch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(patch);
  }

  return deduped;
}

function extractDuplicateProposedPatchArrays(raw: string): unknown[][] {
  const arrays: unknown[][] = [];
  const needle = '"proposedPatches"';
  let cursor = 0;

  while (cursor < raw.length) {
    const keyIndex = raw.indexOf(needle, cursor);
    if (keyIndex === -1) break;

    let colonIndex = keyIndex + needle.length;
    while (colonIndex < raw.length && /\s/.test(raw[colonIndex])) {
      colonIndex += 1;
    }
    if (raw[colonIndex] !== ":") {
      cursor = keyIndex + needle.length;
      continue;
    }

    let valueStart = colonIndex + 1;
    while (valueStart < raw.length && /\s/.test(raw[valueStart])) {
      valueStart += 1;
    }
    if (raw[valueStart] !== "[") {
      cursor = valueStart;
      continue;
    }

    const extracted = extractJsonArray(raw, valueStart);
    if (!extracted) {
      cursor = valueStart + 1;
      continue;
    }

    try {
      const parsed = JSON.parse(extracted.arrayText);
      if (Array.isArray(parsed)) {
        arrays.push(parsed as unknown[]);
      }
    } catch {
      // Ignore malformed arrays and keep scanning.
    }

    cursor = extracted.endIndex;
  }

  return arrays;
}

function extractJsonArray(
  text: string,
  startIndex: number,
): { arrayText: string; endIndex: number } | null {
  if (text[startIndex] !== "[") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") {
      depth += 1;
      continue;
    }

    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          arrayText: text.slice(startIndex, i + 1),
          endIndex: i + 1,
        };
      }
    }
  }

  return null;
}
