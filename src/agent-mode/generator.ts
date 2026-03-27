import type { ChatSession } from "../chat/types.js";
import { jsonrepair } from "jsonrepair";
import type { ModelProvider } from "../providers/model-provider.js";
import type { FileMeta } from "../workspace/workspace-scanner.js";
import {
  parseAgentDecision,
  type AgentDecision,
  type AgentProposedPatch,
} from "../contracts/agent-decision.types.js";
import { resolveContextRequests } from "./context-resolution.js";
import { sanitizeAgentJsonText } from "./response-handler.js";
import { buildAgentDecisionSystemMessage } from "../prompts/prompt-builder.js";
import {
  validatePatchProposal,
  type PatchProposalValidationResult,
} from "../tools/patch-validator.js";

const DECISION_RETRIES = 2;

export interface AgentModeOutcome {
  response: string;
  validProposedPatches: AgentProposedPatch[];
}

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
}): Promise<AgentModeOutcome> {
  const { provider, messagesForModel, workspacePath, scannedFiles } = params;

  // --- Phase 1: Context Decision ---
  const decision = await runDecisionPhase(provider, messagesForModel);
  console.warn(
    `[REI debug] Agent decision: taskType=${decision.taskType}, ready=${decision.ready}, contextRequests=[${decision.contextRequests.map((r) => r.path).join(", ")}]`
  );

  // --- Phase 2: Context Resolution ---
  let answerMessages = messagesForModel;
  if (decision.contextRequests.length > 0) {
    const alreadyResolved = new Set<string>();
    const { contextMessage, resolved } = await resolveContextRequests(
      decision.contextRequests,
      workspacePath,
      alreadyResolved,
      scannedFiles
    );
    if (resolved.length > 0 && contextMessage) {
      console.warn(
        `[REI debug] Agent context resolved ${resolved.length} file(s), injecting into answer phase`
      );
      answerMessages = appendContextToLastUserMessage(messagesForModel, contextMessage);
    }
  }

  // --- Phase 2.5: Patch Validation ---
  let patchValidation = await validateDecisionProposedPatches(
    decision,
    workspacePath,
    scannedFiles
  );

  // If change-planning produced no valid patch, run one focused patch-synthesis attempt.
  if (decision.taskType === "change-planning" && patchValidation.every((item) => !item.validation.valid)) {
    const synthesized = await synthesizePatchesFromContext(provider, messagesForModel);
    if (synthesized.length > 0) {
      const synthesizedValidation = await validateDecisionProposedPatches(
        {
          ...decision,
          proposedPatches: synthesized,
        },
        workspacePath,
        scannedFiles
      );
      if (synthesizedValidation.some((item) => item.validation.valid)) {
        patchValidation = synthesizedValidation;
      }
    }
  }

  // --- Phase 3: Answer ---
  // Free-text response. No JSON contract, no semantic validation.
  const answer = await provider.completeChat(answerMessages);

  const withPatchSection = appendPatchSection(answer, patchValidation);
  return {
    response: withPatchSection,
    validProposedPatches: patchValidation
      .filter((item) => item.validation.valid)
      .map((item) => item.proposal),
  };
}

// ---------------------------------------------------------------------------

async function runDecisionPhase(
  provider: ModelProvider,
  messagesForModel: ChatSession["messages"]
): Promise<AgentDecision> {
  const lastUserMessage = [...messagesForModel].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUserMessage?.content ?? "";
  const currentTask = extractCurrentTask(lastUserContent);
  const decisionMessages: ChatSession["messages"] = [
    { role: "system", content: buildAgentDecisionSystemMessage() },
    ...(lastUserMessage ? [lastUserMessage] : []),
  ];
  const explicitTaskPaths = extractPathLikeTokens(currentTask);
  const providedContextPaths = extractProvidedContextPaths(lastUserContent);

  let raw = await provider.completeChat(decisionMessages);
  let attemptedChangePlanningRecovery = false;

  for (let attempt = 0; attempt <= DECISION_RETRIES; attempt += 1) {
    try {
      const parsed = parseDecisionWithRecovery(raw);
      const decision = normalizeDecision(parsed, currentTask, explicitTaskPaths, providedContextPaths);

      if (
        shouldRetryForMissingChangePatch(
          decision,
          currentTask,
          explicitTaskPaths,
          providedContextPaths,
          attemptedChangePlanningRecovery
        )
      ) {
        attemptedChangePlanningRecovery = true;
        raw = await provider.completeChat([
          ...decisionMessages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: [
              "The task is clearly a change request and target file(s) are already visible in context.",
              "Return a corrected decision JSON with taskType=\"change-planning\" and include at least one proposedPatch.",
              "Do not request placeholder files like src/foo.ts.",
              "Return only JSON. No prose.",
            ].join("\n"),
          },
        ]);
        continue;
      }

      if (attempt > 0) {
        console.warn(`[REI debug] Agent decision parsed after ${attempt + 1} attempt(s)`);
      }
      return decision;
    } catch (err) {
      if (attempt === DECISION_RETRIES) {
        console.warn(
          `[REI debug] Agent decision parsing failed after ${DECISION_RETRIES + 1} attempt(s), using heuristic fallback`
        );
        return buildFallbackDecisionFromTask(currentTask);
      }

      const repairMessages: ChatSession["messages"] = [
        ...decisionMessages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: [
            "Your response was not valid JSON for the context evaluation step.",
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            'Return only a JSON object with these fields: ready (boolean), taskType ("inspection" or "change-planning"), contextRequests (array of {path, reason} objects), proposedPatches (optional array of {file, description, patch}).',
            "No markdown fences, no prose. First character must be { and last must be }.",
            "Use strict booleans (true/false), double quotes, and valid escaped newlines in patch strings.",
            "Example: {\"ready\":true,\"taskType\":\"change-planning\",\"contextRequests\":[],\"proposedPatches\":[]}",
          ].join("\n"),
        },
      ];
      raw = await provider.completeChat(repairMessages);
    }
  }

  /* istanbul ignore next */
  return buildFallbackDecisionFromTask(currentTask);
}

function appendContextToLastUserMessage(
  messages: ChatSession["messages"],
  contextAddendum: string
): ChatSession["messages"] {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].role === "user") {
      result[i] = { ...result[i], content: result[i].content + "\n\n" + contextAddendum };
      return result;
    }
  }
  return result;
}

async function validateDecisionProposedPatches(
  decision: AgentDecision,
  workspacePath: string,
  scannedFiles: FileMeta[]
): Promise<Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>> {
  const proposals = decision.proposedPatches ?? [];
  const results: Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }> = [];

  for (const proposal of proposals) {
    const canonicalProposal = {
      ...proposal,
      file: canonicalizePathAgainstScannedFiles(proposal.file, scannedFiles),
    };
    const validation = await validatePatchProposal(canonicalProposal, workspacePath);
    results.push({ proposal: canonicalProposal, validation });
  }

  return results;
}

function appendPatchSection(
  answer: string,
  validation: Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>
): string {
  if (validation.length === 0) {
    return answer;
  }

  const valid = validation.filter((item) => item.validation.valid);
  const invalid = validation.filter((item) => !item.validation.valid);

  const sections: string[] = [answer, "", "## Patch Proposals", ""];

  if (valid.length > 0) {
    sections.push(`Validated patches: ${valid.length}`);
    sections.push("");
    for (const item of valid) {
      sections.push(`File: ${item.proposal.file}`);
      sections.push(`Reason: ${item.proposal.description || "(no description)"}`);
      sections.push("```diff");
      sections.push(item.proposal.patch.trimEnd());
      sections.push("```");
      sections.push("");
    }
    sections.push("Use /confirm to apply these patches, or /discard to clear them.");
    sections.push("");
  }

  if (invalid.length > 0) {
    sections.push(`Rejected patches: ${invalid.length}`);
    for (const item of invalid) {
      const reasons = item.validation.issues.map((issue) => issue.code).join(", ");
      sections.push(`- ${item.proposal.file}: ${reasons}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function parseDecisionWithRecovery(raw: string): AgentDecision {
  const sanitized = sanitizeAgentJsonText(raw) || raw;

  try {
    return parseAgentDecision(sanitized);
  } catch {
    // Continue with jsonrepair-based recovery.
  }

  const repaired = jsonrepair(sanitized);
  return parseAgentDecision(repaired);
}

function extractCurrentTask(userMessageContent: string): string {
  if (!userMessageContent) return "";
  const taskLine = userMessageContent
    .split("\n")
    .find((line) => line.toLowerCase().startsWith("task:"));

  if (taskLine) {
    return taskLine.slice("Task:".length).trim();
  }

  return userMessageContent.trim();
}

function buildFallbackDecisionFromTask(task: string): AgentDecision {
  const normalized = task.toLowerCase();
  const looksLikeChangeTask =
    /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|agrega[r]?|cambia[r]?|modifica[r]?|actualiza[r]?|arregla[r]?|implementa[r]?|crea[r]?|elimina[r]?|borra[r]?)\b/.test(
      normalized
    );

  return {
    ready: true,
    taskType: looksLikeChangeTask ? "change-planning" : "inspection",
    contextRequests: [],
  };
}

function normalizeDecision(
  decision: AgentDecision,
  task: string,
  explicitTaskPaths: Set<string>,
  providedContextPaths: Set<string>
): AgentDecision {
  const changeIntent = isChangeIntentTask(task);
  const taskType = changeIntent ? "change-planning" : decision.taskType;

  const filteredContextRequests = decision.contextRequests
    .map((request) => {
      const normalizedPath = request.path.replace(/\\/g, "/").replace(/^\/+/, "");
      const canonicalPath = canonicalizePathAgainstProvided(normalizedPath, providedContextPaths);
      return {
        ...request,
        path: canonicalPath,
      };
    })
    .filter((request) => {
      const normalizedPath = request.path;
      if (pathCoveredByTaskOrContext(normalizedPath, explicitTaskPaths, providedContextPaths)) return true;
      return false;
    });

  const normalizedPatches = (decision.proposedPatches ?? []).map((proposal) => ({
    ...proposal,
    file: canonicalizePathAgainstProvided(
      proposal.file.replace(/\\/g, "/").replace(/^\/+/, ""),
      providedContextPaths
    ),
  }));

  return {
    ...decision,
    taskType,
    ready: filteredContextRequests.length === 0 ? true : decision.ready,
    contextRequests: filteredContextRequests,
    ...(normalizedPatches.length > 0 ? { proposedPatches: normalizedPatches } : {}),
  };
}

function shouldRetryForMissingChangePatch(
  decision: AgentDecision,
  task: string,
  explicitTaskPaths: Set<string>,
  providedContextPaths: Set<string>,
  alreadyRetried: boolean
): boolean {
  if (alreadyRetried) return false;
  if (!isChangeIntentTask(task)) return false;
  if (decision.taskType !== "change-planning") return false;
  if ((decision.proposedPatches?.length ?? 0) > 0) return false;
  if (decision.contextRequests.length > 0) return false;

  if (explicitTaskPaths.size === 0) return false;
  return [...explicitTaskPaths].every((p) => pathCoveredByTaskOrContext(p, explicitTaskPaths, providedContextPaths));
}

function extractPathLikeTokens(text: string): Set<string> {
  const matches = text.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
  const paths = new Set<string>();
  for (const match of matches) {
    paths.add(match.replace(/\\/g, "/").replace(/^\/+/, ""));
  }
  return paths;
}

function extractProvidedContextPaths(messageContent: string): Set<string> {
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

function isChangeIntentTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|agrega[r]?|cambia[r]?|modifica[r]?|actualiza[r]?|arregla[r]?|implementa[r]?|crea[r]?|elimina[r]?|borra[r]?)\b/.test(
    normalized
  );
}

function pathCoveredByTaskOrContext(
  candidatePath: string,
  explicitTaskPaths: Set<string>,
  providedContextPaths: Set<string>
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

function canonicalizePathAgainstProvided(pathCandidate: string, providedContextPaths: Set<string>): string {
  if (providedContextPaths.has(pathCandidate)) return pathCandidate;

  const base = pathCandidate.split("/").pop() ?? pathCandidate;
  const matches = [...providedContextPaths].filter(
    (provided) => provided === base || provided.endsWith(`/${base}`)
  );

  if (matches.length === 1) {
    return matches[0];
  }

  return pathCandidate;
}

function canonicalizePathAgainstScannedFiles(pathCandidate: string, scannedFiles: FileMeta[]): string {
  const normalized = pathCandidate.replace(/\\/g, "/").replace(/^\/+/, "");
  const scannedSet = new Set(scannedFiles.map((f) => f.path.replace(/\\/g, "/")));

  if (scannedSet.has(normalized)) {
    return normalized;
  }

  const base = normalized.split("/").pop() ?? normalized;
  const matches = [...scannedSet].filter((p) => p === base || p.endsWith(`/${base}`));
  if (matches.length === 1) {
    return matches[0];
  }

  return normalized;
}

async function synthesizePatchesFromContext(
  provider: ModelProvider,
  messagesForModel: ChatSession["messages"]
): Promise<AgentProposedPatch[]> {
  const lastUserMessage = [...messagesForModel].reverse().find((m) => m.role === "user");
  if (!lastUserMessage) return [];

  const synthesisMessages: ChatSession["messages"] = [
    {
      role: "system",
      content: [
        "You are REI in patch synthesis mode.",
        "Generate concrete unified diff patches for the requested change using ONLY visible context.",
        "Return JSON only with this exact shape:",
        '{"proposedPatches":[{"file":"src/file.ts","description":"short reason","patch":"--- a/src/file.ts\\n+++ b/src/file.ts\\n@@ ..."}]}',
        "Rules:",
        "- Use workspace-relative file paths.",
        "- Use valid unified diff headers and hunks.",
        "- Do not invent files not present in context.",
        "- If impossible, return {\"proposedPatches\":[]}",
      ].join("\n"),
    },
    { role: "user", content: lastUserMessage.content },
  ];

  const raw = await provider.completeChat(synthesisMessages);
  const sanitized = sanitizeAgentJsonText(raw) || raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitized);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(sanitized));
    } catch {
      return [];
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.proposedPatches)) return [];

  const proposals: AgentProposedPatch[] = [];
  for (const item of obj.proposedPatches) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    const file = typeof p.file === "string" ? p.file : "";
    const patch = typeof p.patch === "string" ? p.patch : "";
    if (!file || !patch) continue;
    proposals.push({
      file,
      patch,
      description: typeof p.description === "string" ? p.description : "",
    });
  }

  return proposals;
}
