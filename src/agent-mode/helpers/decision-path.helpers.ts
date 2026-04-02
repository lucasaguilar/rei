import type { AgentDecision } from "../../contracts/agent-decision.types.js";
import type { FileMeta } from "../../workspace/workspace-scanner.js";

const CHANGE_INTENT_PATTERN =
  /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|comment|disable|rename|cleanup|agreg\w*|cambi\w*|modific\w*|actualiz\w*|arregl\w*|implement\w*|cre\w*|elimin\w*|borr\w*|coment\w*|deshabilit\w*|renombr\w*|refactoriz\w*|reescrib\w*)\b/;
const INSPECTION_INTENT_PATTERN =
  /\b(explain|how|why|what|show|review|inspect|analy[sz]e|necesito saber|explica|como funciona|cómo funciona|que palabras|qué palabras|solo|sin cambiar|read-only|read only)\b/;

export function extractCurrentTask(userMessageContent: string): string {
  if (!userMessageContent) return "";
  const taskLine = userMessageContent
    .split("\n")
    .find((line) => line.toLowerCase().startsWith("task:"));

  if (taskLine) {
    return taskLine.slice("Task:".length).trim();
  }

  return userMessageContent.trim();
}

export function buildFallbackDecisionFromTask(task: string): AgentDecision {
  const normalized = task.toLowerCase();
  const looksLikeChangeTask = CHANGE_INTENT_PATTERN.test(normalized);

  return {
    ready: true,
    taskType: looksLikeChangeTask ? "change-planning" : "inspection",
    contextRequests: [],
  };
}

export function normalizeDecision(
  decision: AgentDecision,
  task: string,
  explicitTaskPaths: Set<string>,
  providedContextPaths: Set<string>,
): AgentDecision {
  const changeIntent = isChangeIntentTask(task);
  const taskType = changeIntent ? "change-planning" : decision.taskType;

  const filteredContextRequests = decision.contextRequests
    .map((request) => {
      const normalizedPath = request.path
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
      const canonicalPath = canonicalizePathAgainstProvided(
        normalizedPath,
        providedContextPaths,
      );
      return {
        ...request,
        path: canonicalPath,
      };
    })
    .filter((request) => {
      const normalizedPath = request.path;
      return pathCoveredByTaskOrContext(
        normalizedPath,
        explicitTaskPaths,
        providedContextPaths,
      );
    });

  const normalizedPatches = (decision.proposedPatches ?? []).map(
    (proposal) => ({
      ...proposal,
      file: canonicalizePathAgainstProvided(
        proposal.file.replace(/\\/g, "/").replace(/^\/+/, ""),
        providedContextPaths,
      ),
    }),
  );

  return {
    ...decision,
    taskType,
    ready: filteredContextRequests.length === 0 ? true : decision.ready,
    contextRequests: filteredContextRequests,
    ...(normalizedPatches.length > 0
      ? { proposedPatches: normalizedPatches }
      : {}),
  };
}

export function shouldRetryForMissingChangePatch(
  decision: AgentDecision,
  task: string,
  explicitTaskPaths: Set<string>,
  providedContextPaths: Set<string>,
  alreadyRetried: boolean,
): boolean {
  if (alreadyRetried) return false;
  if (!isChangeIntentTask(task)) return false;
  if (decision.taskType !== "change-planning") return false;
  if ((decision.proposedPatches?.length ?? 0) > 0) return false;
  if (decision.contextRequests.length > 0) return false;
  if (explicitTaskPaths.size === 0) return false;

  return [...explicitTaskPaths].every((candidatePath) =>
    pathCoveredByTaskOrContext(
      candidatePath,
      new Set<string>(),
      providedContextPaths,
    ),
  );
}

export function extractPathLikeTokens(text: string): Set<string> {
  const matches = text.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
  const paths = new Set<string>();
  for (const match of matches) {
    paths.add(match.replace(/\\/g, "/").replace(/^\/+/, ""));
  }
  return paths;
}

export function extractProvidedContextPaths(
  messageContent: string,
): Set<string> {
  const paths = new Set<string>();

  for (const line of messageContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const candidate = trimmed.slice(2).trim();
    if (/^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(candidate)) {
      paths.add(candidate.replace(/\\/g, "/").replace(/^\/+/, ""));
    }
  }

  return paths;
}

export function canonicalizePathAgainstScannedFiles(
  pathCandidate: string,
  scannedFiles: FileMeta[],
): string {
  const normalized = pathCandidate.replace(/\\/g, "/").replace(/^\/+/, "");
  const scannedSet = new Set(
    scannedFiles.map((file) => file.path.replace(/\\/g, "/")),
  );

  if (scannedSet.has(normalized)) {
    return normalized;
  }

  const base = normalized.split("/").pop() ?? normalized;
  const matches = [...scannedSet].filter(
    (candidate) => candidate === base || candidate.endsWith(`/${base}`),
  );
  if (matches.length === 1) {
    return matches[0];
  }

  return normalized;
}

function isChangeIntentTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const hasChangeIntent = CHANGE_INTENT_PATTERN.test(normalized);
  if (!hasChangeIntent) return false;

  const hasExplicitTarget =
    extractPathLikeTokens(task).size > 0 ||
    /\b(file|function|class|component|archivo|funci[oó]n|clase|componente)\b/i.test(
      task,
    );

  const looksLikeInspection =
    INSPECTION_INTENT_PATTERN.test(normalized) && !hasExplicitTarget;
  if (looksLikeInspection) return false;

  return true;
}

function pathCoveredByTaskOrContext(
  candidatePath: string,
  explicitTaskPaths: Set<string>,
  providedContextPaths: Set<string>,
): boolean {
  if (explicitTaskPaths.has(candidatePath)) return true;
  if (providedContextPaths.has(candidatePath)) return true;

  const base = candidatePath.split("/").pop() ?? candidatePath;
  if (explicitTaskPaths.has(base)) return true;

  for (const provided of providedContextPaths) {
    if (provided.endsWith(`/${base}`) || provided === base) {
      return true;
    }
  }

  return false;
}

function canonicalizePathAgainstProvided(
  pathCandidate: string,
  providedContextPaths: Set<string>,
): string {
  if (providedContextPaths.has(pathCandidate)) return pathCandidate;

  const base = pathCandidate.split("/").pop() ?? pathCandidate;
  const matches = [...providedContextPaths].filter(
    (provided) => provided === base || provided.endsWith(`/${base}`),
  );

  if (matches.length === 1) {
    return matches[0];
  }

  return pathCandidate;
}
