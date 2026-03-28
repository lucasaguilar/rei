import * as fs from "fs/promises";
import * as path from "path";
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
  type PatchValidationIssue,
} from "../tools/patch-validator.js";
import { extractFileFromPatch, generateUnifiedDiff } from "../tools/patch-generator.js";

const DECISION_RETRIES = 2;
const PATCH_CRITIC_RETRIES = 2;
const RETRYABLE_PATCH_CODES = new Set<PatchValidationIssue["code"]>([
  "GIT_APPLY_CHECK_FAILED",
  "INVALID_PATCH_HEADERS",
  "MISSING_HUNKS",
  "TARGET_FILE_MISMATCH",
]);
const CHANGE_INTENT_PATTERN =
  /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|write|insert|patch|comment|disable|rename|cleanup|agreg\w*|cambi\w*|modific\w*|actualiz\w*|arregl\w*|implement\w*|cre\w*|elimin\w*|borr\w*|coment\w*|deshabilit\w*|renombr\w*|refactoriz\w*|reescrib\w*)\b/;

export interface AgentModeOutcome {
  response: string;
  validProposedPatches: AgentProposedPatch[];
}

export interface AgentContextPrelude {
  answerMessages: ChatSession["messages"];
  patchValidation: Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>;
  decision: AgentDecision;
}

export async function prepareAgentContext(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
}): Promise<AgentContextPrelude> {
  const { provider, messagesForModel, workspacePath, scannedFiles } = params;

  // --- Phase 1: Context Decision ---
  const decision = await runDecisionPhase(provider, messagesForModel);

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
      answerMessages = appendContextToLastUserMessage(messagesForModel, contextMessage);
    }
  }

  // --- Phase 2.5: Patch Validation ---
  let patchValidation = await validateDecisionProposedPatches(
    decision,
    workspacePath,
    scannedFiles
  );

  // 2.5.a: Critic loop — intenta corregir patches inválidos con códigos reintentables
  if (decision.taskType === "change-planning" && patchValidation.some((item) => !item.validation.valid)) {
    patchValidation = await runPatchCriticLoop(
      provider,
      answerMessages,
      workspacePath,
      scannedFiles,
      patchValidation
    );
  }

  // 2.5.b: Si aún no hay ningún patch válido, intenta síntesis desde contexto
  if (decision.taskType === "change-planning" && patchValidation.every((item) => !item.validation.valid)) {
    const synthesized = await synthesizePatchesFromContext(provider, answerMessages, workspacePath);
    if (synthesized.length > 0) {
      let synthesizedValidation = await validateDecisionProposedPatches(
        { ...decision, proposedPatches: synthesized },
        workspacePath,
        scannedFiles
      );

      // Run critic loop on synthesized patches that failed validation
      if (synthesizedValidation.some((item) => !item.validation.valid)) {
        synthesizedValidation = await runPatchCriticLoop(
          provider,
          answerMessages,
          workspacePath,
          scannedFiles,
          synthesizedValidation
        );
      }

      if (synthesizedValidation.some((item) => item.validation.valid)) {
        patchValidation = synthesizedValidation;
      } else if (patchValidation.length === 0) {
        // Show rejected synthesized patches so the user sees what failed
        patchValidation = synthesizedValidation;
      }
    }
  }

  return { answerMessages, patchValidation, decision };
}

export function buildAgentFinalResponse(
  answer: string,
  prelude: AgentContextPrelude
): AgentModeOutcome {
  const withPatchSection = appendPatchSection(answer, prelude.patchValidation, prelude.decision.taskType);
  return {
    response: withPatchSection,
    validProposedPatches: prelude.patchValidation
      .filter((item) => item.validation.valid)
      .map((item) => item.proposal),
  };
}

export async function generateAgentModeResponse(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  scannedFiles: FileMeta[];
}): Promise<AgentModeOutcome> {
  const { provider, messagesForModel, workspacePath, scannedFiles } = params;

  const prelude = await prepareAgentContext({ provider, messagesForModel, workspacePath, scannedFiles });
  const answer = await provider.completeChat(prelude.answerMessages);
  return buildAgentFinalResponse(answer, prelude);
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

      return decision;
    } catch (err) {
      if (attempt === DECISION_RETRIES) {
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

/**
 * Normalize common LLM patch mistakes before validation:
 * - Missing `a/` / `b/` prefixes on `---` / `+++` headers
 * - Literal `\\n` instead of real newlines (double-encoded JSON)
 * - Missing trailing newline
 * - Trim leading/trailing whitespace per line in headers
 */
function normalizePatch(patch: string, expectedFile: string): string {
  // Fix double-encoded newlines (literal \\n in string)
  let text = patch;
  if (!text.includes("\n") && text.includes("\\n")) {
    text = text.replace(/\\n/g, "\n");
  }

  const lines = text.split("\n");
  const normalized: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    // Fix --- header: ensure `a/` prefix
    if (line.startsWith("--- ")) {
      const after = line.slice(4).trim();
      if (!after.startsWith("a/") && !after.startsWith("/dev/null")) {
        const clean = after.replace(/^\/+/, "");
        line = `--- a/${clean}`;
      }
    }

    // Fix +++ header: ensure `b/` prefix
    if (line.startsWith("+++ ")) {
      const after = line.slice(4).trim();
      if (!after.startsWith("b/") && !after.startsWith("/dev/null")) {
        const clean = after.replace(/^\/+/, "");
        line = `+++ b/${clean}`;
      }
    }

    normalized.push(line);
  }

  // If no --- / +++ headers at all, prepend them
  const hasOld = normalized.some((l) => l.startsWith("--- "));
  const hasNew = normalized.some((l) => l.startsWith("+++ "));
  if (!hasOld || !hasNew) {
    const filePath = expectedFile.replace(/^\/+/, "");
    if (!hasOld) normalized.unshift(`--- a/${filePath}`);
    if (!hasNew) {
      const oldIdx = normalized.findIndex((l) => l.startsWith("--- "));
      normalized.splice(oldIdx + 1, 0, `+++ b/${filePath}`);
    }
  }

  let result = normalized.join("\n");
  if (!result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

async function validateDecisionProposedPatches(
  decision: AgentDecision,
  workspacePath: string,
  scannedFiles: FileMeta[]
): Promise<Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>> {
  const proposals = expandPatchProposals(decision.proposedPatches ?? []);
  const results: Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }> = [];

  for (const proposal of proposals) {
    const canonicalFile = canonicalizePathAgainstScannedFiles(proposal.file, scannedFiles);
    const canonicalProposal = {
      ...proposal,
      file: canonicalFile,
      patch: normalizePatch(proposal.patch, canonicalFile),
    };
    const validation = await validatePatchProposal(canonicalProposal, workspacePath);
    results.push({ proposal: canonicalProposal, validation });
  }

  return results;
}

function appendPatchSection(
  answer: string,
  validation: Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>,
  taskType: AgentDecision["taskType"]
): string {
  if (validation.length === 0 && taskType !== "change-planning") {
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

  if (taskType === "change-planning" && valid.length === 0) {
    sections.push("Validated patches: 0");
    sections.push("No applicable patch could be generated from the current context.");
    sections.push("Tip: mention concrete files/functions (or use @path) and ask for exact edits.");
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

function expandPatchProposals(proposals: AgentProposedPatch[]): AgentProposedPatch[] {
  const expanded: AgentProposedPatch[] = [];

  for (const proposal of proposals) {
    const split = splitMultiFilePatch(proposal.patch);
    if (split.length <= 1) {
      expanded.push(proposal);
      continue;
    }

    for (let i = 0; i < split.length; i += 1) {
      const part = split[i];
      expanded.push({
        file: part.file || proposal.file,
        description: proposal.description
          ? `${proposal.description} (part ${i + 1}/${split.length})`
          : `Patch part ${i + 1}/${split.length}`,
        patch: part.patch,
      });
    }
  }

  return expanded;
}

function splitMultiFilePatch(patchText: string): Array<{ file: string; patch: string }> {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const sections: string[][] = [];
  let current: string[] | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";

    if (line.startsWith("--- ") && next.startsWith("+++ ")) {
      if (current && current.length > 0) {
        sections.push(current);
      }
      current = [line, next];
      i += 1;
      continue;
    }

    if (current) {
      current.push(line);
    }
  }

  if (current && current.length > 0) {
    sections.push(current);
  }

  if (sections.length <= 1) {
    return [];
  }

  const out: Array<{ file: string; patch: string }> = [];
  for (const section of sections) {
    const patch = `${section.join("\n").trimEnd()}\n`;
    const info = extractFileFromPatch(patch);
    if (!info) continue;
    out.push({ file: info.file, patch });
  }

  return out;
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
  const looksLikeChangeTask = CHANGE_INTENT_PATTERN.test(normalized);

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
  // Only retry if all explicit task paths are actually covered by the provided context,
  // to avoid triggering retries based solely on the presence of explicitTaskPaths.
  return [...explicitTaskPaths].every((p) =>
    pathCoveredByTaskOrContext(p, new Set<string>(), providedContextPaths)
  );
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
  return CHANGE_INTENT_PATTERN.test(normalized);
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

interface SearchReplaceBlock {
  file: string;
  description: string;
  search: string;
  replace: string;
}

async function synthesizePatchesFromContext(
  provider: ModelProvider,
  messagesForModel: ChatSession["messages"],
  workspacePath: string
): Promise<AgentProposedPatch[]> {
  const lastUserMessage = [...messagesForModel].reverse().find((m) => m.role === "user");
  if (!lastUserMessage) return [];

  const contextMessages = messagesForModel.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  const synthesisMessages: ChatSession["messages"] = [
    {
      role: "system",
      content: [
        "You are REI in patch synthesis mode.",
        "Generate concrete SEARCH/REPLACE edits for the requested change.",
        "Return JSON only with this exact shape:",
        '{"edits":[{"file":"src/file.ts","description":"short reason","search":"exact lines to find","replace":"replacement lines"}]}',
        "",
        "Rules:",
        '- "search" must be an EXACT contiguous substring of the current file content (copy-paste precision).',
        '- "replace" is what replaces the search block.',
        "- Include enough context lines in search to uniquely identify the location (typically 2-3 lines before and after).",
        "- For insertions: search for the lines around the insertion point, and include the new code in replace along with those context lines.",
        "- For deletions: search for the block to remove (with context), and replace with just the context lines.",
        "- Each edit targets exactly ONE file.",
        "- Use workspace-relative file paths (no leading /).",
        "- Use ONLY file content visible in the conversation. Do not invent code.",
        '- If impossible, return {"edits":[]}',
      ].join("\n"),
    },
    ...contextMessages.slice(-4),
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
  if (!Array.isArray(obj.edits)) return [];

  const edits: SearchReplaceBlock[] = [];
  for (const item of obj.edits) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file : "";
    const search = typeof e.search === "string" ? e.search : "";
    const replace = typeof e.replace === "string" ? e.replace : "";
    if (!file || !search) continue;
    edits.push({
      file,
      search,
      replace,
      description: typeof e.description === "string" ? e.description : "",
    });
  }

  return buildPatchesFromEdits(edits, workspacePath);
}

async function buildPatchesFromEdits(
  edits: SearchReplaceBlock[],
  workspacePath: string
): Promise<AgentProposedPatch[]> {
  // Group edits by file so we can apply multiple edits to the same file sequentially
  const byFile = new Map<string, SearchReplaceBlock[]>();
  for (const edit of edits) {
    const existing = byFile.get(edit.file) ?? [];
    existing.push(edit);
    byFile.set(edit.file, existing);
  }

  const patches: AgentProposedPatch[] = [];

  for (const [file, fileEdits] of byFile) {
    const absPath = path.join(workspacePath, file);
    let before: string;
    try {
      before = await fs.readFile(absPath, "utf-8");
    } catch {
      continue; // File doesn't exist, skip
    }

    let after = before;
    const appliedDescriptions: string[] = [];

    for (const edit of fileEdits) {
      // Normalize line endings for matching
      const normalizedAfter = after.replace(/\r\n/g, "\n");
      const normalizedSearch = edit.search.replace(/\r\n/g, "\n");

      const idx = normalizedAfter.indexOf(normalizedSearch);
      if (idx === -1) {
        // Try trimmed match as fallback (whitespace differences)
        const trimmedSearch = normalizedSearch.split("\n").map(l => l.trimEnd()).join("\n");
        const trimmedAfter = normalizedAfter.split("\n").map(l => l.trimEnd()).join("\n");
        const trimmedIdx = trimmedAfter.indexOf(trimmedSearch);
        if (trimmedIdx === -1) continue;

        // Map trimmedIdx back to original string offset
        // Count newlines up to trimmedIdx to find the line
        const lineNum = trimmedAfter.slice(0, trimmedIdx).split("\n").length - 1;
        const lines = normalizedAfter.split("\n");
        const searchLines = normalizedSearch.split("\n");
        const originalSlice = lines.slice(lineNum, lineNum + searchLines.length).join("\n");
        after = after.replace(originalSlice, edit.replace.replace(/\r\n/g, "\n"));
      } else {
        after = normalizedAfter.slice(0, idx) + edit.replace.replace(/\r\n/g, "\n") + normalizedAfter.slice(idx + normalizedSearch.length);
      }
      appliedDescriptions.push(edit.description);
    }

    if (after === before) continue;

    const diff = generateUnifiedDiff(file, before, after);
    if (!diff) continue;

    patches.push({
      file,
      patch: diff,
      description: appliedDescriptions.join("; ") || "Synthesized edit",
    });
  }

  return patches;
}

async function runPatchCriticLoop(
  provider: ModelProvider,
  messagesForModel: ChatSession["messages"],
  workspacePath: string,
  scannedFiles: FileMeta[],
  patchValidation: Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>
): Promise<Array<{ proposal: AgentProposedPatch; validation: PatchProposalValidationResult }>> {
  const result = [...patchValidation];

  for (let i = 0; i < result.length; i += 1) {
    const item = result[i];
    if (item.validation.valid) continue;

    const retryableCodes = item.validation.issues.filter((iss) =>
      RETRYABLE_PATCH_CODES.has(iss.code)
    );
    if (retryableCodes.length === 0) continue;

    // Instead of asking for corrected diffs, ask for search/replace edits
    // which we can convert into valid diffs programmatically
    const criticMessages: ChatSession["messages"] = [
      ...messagesForModel,
      {
        role: "user",
        content: [
          `The patch for "${item.proposal.file}" failed validation:`,
          retryableCodes.map((iss) => `- ${iss.code}: ${iss.message}`).join("\n"),
          "",
          "Instead of a raw diff, return a search/replace edit as JSON:",
          '{"file":"...","description":"...","search":"exact lines to find in the file","replace":"replacement lines"}',
          "",
          "Rules:",
          '- "search" must be an exact substring of the file content.',
          "- Include 2-3 context lines to uniquely identify the location.",
          "- Do not add prose. First char must be {.",
        ].join("\n"),
      },
    ];

    for (let attempt = 0; attempt < PATCH_CRITIC_RETRIES; attempt += 1) {
      const raw = await provider.completeChat(criticMessages);
      const sanitized = sanitizeAgentJsonText(raw) || raw;

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(sanitized) as Record<string, unknown>;
      } catch {
        try {
          parsed = JSON.parse(jsonrepair(sanitized)) as Record<string, unknown>;
        } catch { /* skip */ }
      }

      if (!parsed || typeof parsed.file !== "string") continue;

      const file = canonicalizePathAgainstScannedFiles(
        (parsed.file as string) || item.proposal.file,
        scannedFiles
      );
      const description = typeof parsed.description === "string"
        ? parsed.description
        : item.proposal.description;

      // If the model returned search/replace, build the patch programmatically
      if (typeof parsed.search === "string" && typeof parsed.replace === "string") {
        const edits: SearchReplaceBlock[] = [{
          file,
          description,
          search: parsed.search as string,
          replace: parsed.replace as string,
        }];

        const patches = await buildPatchesFromEdits(edits, workspacePath);
        if (patches.length > 0) {
          const validation = await validatePatchProposal(patches[0], workspacePath);
          if (validation.valid) {
            result[i] = { proposal: patches[0], validation };
            break;
          }
        }
      }

      // Fallback: if the model returned a raw patch instead
      if (typeof parsed.patch === "string") {
        const corrected: AgentProposedPatch = {
          file,
          patch: normalizePatch(parsed.patch as string, file),
          description,
        };
        const validation = await validatePatchProposal(corrected, workspacePath);
        if (validation.valid) {
          result[i] = { proposal: corrected, validation };
          break;
        }
      }

      if (attempt < PATCH_CRITIC_RETRIES - 1) {
        criticMessages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content: [
              "That edit could not be applied.",
              "Make sure the \"search\" field is an exact copy of lines from the file.",
              "Return the corrected JSON object.",
            ].join("\n"),
          }
        );
      }
    }
  }

  return result;
}
