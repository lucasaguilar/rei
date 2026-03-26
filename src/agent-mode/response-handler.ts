import * as path from "path";
import { jsonrepair } from "jsonrepair";
import {
  parseAgentResponse,
  validateAgentResponse,
  type AgentResponse,
} from "../contracts/agent-response.types.js";

export type ParseRecoveryStage = "direct" | "sanitized" | "repaired";

export function parseAgentResponseWithRecovery(rawResponse: string): {
  response: AgentResponse;
  stage: ParseRecoveryStage;
} {
  try {
    return { response: parseAgentResponse(rawResponse), stage: "direct" };
  } catch {
    // continue with conservative recovery steps
  }

  const sanitized = sanitizeAgentJsonText(rawResponse);
  if (sanitized) {
    try {
      return { response: parseAgentResponse(sanitized), stage: "sanitized" };
    } catch {
      // continue with syntactic repair
    }

    try {
      const repaired = jsonrepair(sanitized);
      return { response: parseAgentResponse(repaired), stage: "repaired" };
    } catch {
      // fall through to throw original parse error below
    }
  }

  return { response: parseAgentResponse(rawResponse), stage: "direct" };
}

export function buildAgentRepairPrompt(validationError: string): string {
  const isSemantic = validationError.includes("semantic");
  const isPathError = validationError.includes("workspace-relative path");

  const extra: string[] = [];

  if (isSemantic) {
    extra.push(
      "IMPORTANT: Write summary and finalMessage in proposal tense (e.g. \"Propose to add…\", \"Would add…\") for change-oriented analysis tasks.",
      "Exception: for read-only inspection tasks that ask to show or explain existing code/content, summary and finalMessage may describe the inspection as completed, but must not claim repository modifications were applied.",
      "If the task requests a repository change, include at least one modify action or one proposedChange."
    );
  }

  if (isPathError) {
    extra.push(
      "IMPORTANT: All file paths (in actions[].target, proposedChanges[].file, contextRequests[].path) must be workspace-relative (e.g. \"src/main.ts\", NOT \"/workspaces/rei/src/main.ts\")."
    );
  }

  return [
    "Your previous AGENT mode response failed validation.",
    `Validation error: ${validationError}`,
    "Return a corrected response as raw JSON only.",
    "Do not include markdown fences or extra prose.",
    "The first character of your response must be { and the last character must be }.",
    "Your response must not contain triple backticks anywhere.",
    "Keep the same intent and include every required field from the AGENT contract.",
    ...extra,
  ].join("\n");
}

export function sanitizeAgentJsonText(rawResponse: string): string {
  let candidate = rawResponse.trim();
  if (!candidate) return "";

  if (candidate.charCodeAt(0) === 0xfeff) {
    candidate = candidate.slice(1);
  }

  candidate = candidate
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1).trim();
  }

  return candidate;
}

export function normalizeAgentResponsePathsOnParsed(
  response: AgentResponse,
  workspacePath: string
): AgentResponse {
  const absoluteBase = path.resolve(workspacePath).replace(/\\/g, "/");

  function stripWorkspacePrefix(value: string): string {
    const normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith(absoluteBase + "/")) {
      return normalized.slice(absoluteBase.length + 1);
    }
    return value;
  }

  return {
    ...response,
    actions: response.actions.map((action) => ({
      ...action,
      target: stripWorkspacePrefix(action.target),
    })),
    proposedChanges: response.proposedChanges.map((change) => ({
      ...change,
      file: stripWorkspacePrefix(change.file),
    })),
    contextRequests: response.contextRequests.map((req) => ({
      ...req,
      path: stripWorkspacePrefix(req.path),
    })),
  };
}

export function normalizeAgentResponsePaths(raw: string, workspacePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return raw;
  }

  const record = parsed as Record<string, unknown>;
  const absoluteBase = path.resolve(workspacePath).replace(/\\/g, "/");

  function stripWorkspacePrefix(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith(absoluteBase + "/")) {
      return normalized.slice(absoluteBase.length + 1);
    }
    return value;
  }

  if (Array.isArray(record.actions)) {
    record.actions = (record.actions as unknown[]).map((action) => {
      if (typeof action === "object" && action !== null) {
        const a = action as Record<string, unknown>;
        return { ...a, target: stripWorkspacePrefix(a.target) };
      }
      return action;
    });
  }

  if (Array.isArray(record.proposedChanges)) {
    record.proposedChanges = (record.proposedChanges as unknown[]).map((change) => {
      if (typeof change === "object" && change !== null) {
        const c = change as Record<string, unknown>;
        return { ...c, file: stripWorkspacePrefix(c.file) };
      }
      return change;
    });
  }

  if (Array.isArray(record.contextRequests)) {
    record.contextRequests = (record.contextRequests as unknown[]).map((req) => {
      if (typeof req === "object" && req !== null) {
        const r = req as Record<string, unknown>;
        return { ...r, path: stripWorkspacePrefix(r.path) };
      }
      return req;
    });
  }

  return JSON.stringify(record);
}

export function buildDegradedAgentFallback(
  rawResponse: string,
  error?: Error,
  cause: "structural" | "semantic" = "structural"
): AgentResponse {
  const excerpt = sanitizeAgentJsonText(rawResponse).slice(0, 240);
  const detail = error?.message ?? "unknown parsing/validation error";
  const causeLabel = cause === "semantic" ? "non-conforming-agent-semantics" : "non-conforming-agent-output";
  const causeText = cause === "semantic" ? "semantically aligned" : "parsed/validated";

  return validateAgentResponse({
    version: "1.0",
    mode: "agent",
    summary:
      "The model returned a non-conforming AGENT response; REI produced a degraded fallback.",
    confidence: 0,
    needsMoreContext: false,
    contextRequests: [],
    actions: [],
    proposedChanges: [],
    risks: [
      {
        label: causeLabel,
        detail: `Model output could not be ${causeText} (${detail}).`,
      },
    ],
    finalMessage: excerpt
      ? `The model response was not valid for the AGENT contract (${cause}). Sanitized excerpt: ${excerpt}`
      : `The model response was not valid for the AGENT contract (${cause}) and could not be recovered.`,
  });
}