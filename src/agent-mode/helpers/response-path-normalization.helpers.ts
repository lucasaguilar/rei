import * as path from "path";
import type { AgentResponse } from "../../contracts/agent-response.types.js";

export function normalizeAgentResponsePathsOnParsed(
  response: AgentResponse,
  workspacePath: string,
): AgentResponse {
  const stripWorkspacePrefix = buildWorkspacePrefixStripper(workspacePath);

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
    contextRequests: response.contextRequests.map((request) => ({
      ...request,
      path: stripWorkspacePrefix(request.path),
    })),
  };
}

export function normalizeAgentResponsePaths(
  raw: string,
  workspacePath: string,
): string {
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
  const stripWorkspacePrefix = buildWorkspacePrefixStripper(workspacePath);
  const stripUnknownPath = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    return stripWorkspacePrefix(value);
  };

  if (Array.isArray(record.actions)) {
    record.actions = (record.actions as unknown[]).map((action) => {
      if (typeof action !== "object" || action === null) return action;
      const candidate = action as Record<string, unknown>;
      return { ...candidate, target: stripUnknownPath(candidate.target) };
    });
  }

  if (Array.isArray(record.proposedChanges)) {
    record.proposedChanges = (record.proposedChanges as unknown[]).map(
      (change) => {
        if (typeof change !== "object" || change === null) return change;
        const candidate = change as Record<string, unknown>;
        return { ...candidate, file: stripUnknownPath(candidate.file) };
      },
    );
  }

  if (Array.isArray(record.contextRequests)) {
    record.contextRequests = (record.contextRequests as unknown[]).map(
      (request) => {
        if (typeof request !== "object" || request === null) return request;
        const candidate = request as Record<string, unknown>;
        return { ...candidate, path: stripUnknownPath(candidate.path) };
      },
    );
  }

  return JSON.stringify(record);
}

function buildWorkspacePrefixStripper(
  workspacePath: string,
): (value: string) => string {
  const absoluteBase = path.resolve(workspacePath).replace(/\\/g, "/");

  return (value: string) => {
    const normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith(absoluteBase + "/")) {
      return normalized.slice(absoluteBase.length + 1);
    }
    return value;
  };
}
