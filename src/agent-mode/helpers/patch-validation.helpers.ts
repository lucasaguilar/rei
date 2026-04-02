import type {
  AgentDecision,
  AgentProposedPatch,
} from "../../contracts/agent-decision.types.js";
import type { AgentLogger } from "../../core/logger.js";
import type { FileMeta } from "../../workspace/workspace-scanner.js";
import type { PatchProposalValidationResult } from "../../tools/patch-validator.js";
import { extractFileFromPatch } from "../../tools/patch-generator.js";
import type { PatchValidationEntry } from "../models/patch.types.js";
import { canonicalizePathAgainstScannedFiles } from "./decision-path.helpers.js";

export async function validateDecisionProposedPatches(params: {
  decision: AgentDecision;
  workspacePath: string;
  scannedFiles: FileMeta[];
  logger: AgentLogger;
  validateProposal: (
    proposal: AgentProposedPatch,
    workspacePath: string,
    logger?: AgentLogger,
  ) => Promise<PatchProposalValidationResult>;
}): Promise<PatchValidationEntry[]> {
  const { decision, workspacePath, scannedFiles, logger, validateProposal } =
    params;
  const proposals = expandPatchProposals(decision.proposedPatches ?? []);
  const results: PatchValidationEntry[] = [];

  for (const proposal of proposals) {
    const canonicalFile = canonicalizePathAgainstScannedFiles(
      proposal.file,
      scannedFiles,
    );

    const canonicalProposal = {
      ...proposal,
      file: canonicalFile,
      patch: normalizePatch(proposal.patch, canonicalFile),
    };
    logger.logPatchProposal(canonicalFile, canonicalProposal.patch);
    const validation = await validateProposal(
      canonicalProposal,
      workspacePath,
      logger,
    );
    results.push({ proposal: canonicalProposal, validation });
  }

  return results;
}

export function appendPatchSection(
  answer: string,
  validation: PatchValidationEntry[],
  taskType: AgentDecision["taskType"],
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
      sections.push(
        `Reason: ${item.proposal.description || "(no description)"}`,
      );
      sections.push("```diff");
      sections.push(item.proposal.patch.trimEnd());
      sections.push("```");
      sections.push("");
    }
    sections.push(
      "Use /confirm to apply these patches, or /discard to clear them.",
    );
    sections.push("");
  }

  if (taskType === "change-planning" && valid.length === 0) {
    sections.push("Validated patches: 0");
    sections.push(
      "No applicable patch could be generated from the current context.",
    );
    sections.push(
      "Tip: mention concrete files/functions (or use @path) and ask for exact edits.",
    );
    sections.push("");
  }

  if (invalid.length > 0) {
    sections.push(`Rejected patches: ${invalid.length}`);
    for (const item of invalid) {
      const reasons = item.validation.issues
        .map((issue) => issue.code)
        .join(", ");
      sections.push(`- ${item.proposal.file}: ${reasons}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

export function normalizePatch(patch: string, expectedFile: string): string {
  let text = patch;
  if (!text.includes("\n") && text.includes("\\n")) {
    text = text.replace(/\\n/g, "\n");
  }

  const lines = text.split("\n");
  const normalized: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    if (line.startsWith("--- ")) {
      const after = line.slice(4).trim();
      if (!after.startsWith("a/") && !after.startsWith("/dev/null")) {
        const clean = after.replace(/^\/+/, "");
        line = `--- a/${clean}`;
      }
    }

    if (line.startsWith("+++ ")) {
      const after = line.slice(4).trim();
      if (!after.startsWith("b/") && !after.startsWith("/dev/null")) {
        const clean = after.replace(/^\/+/, "");
        line = `+++ b/${clean}`;
      }
    }

    normalized.push(line);
  }

  const hasOld = normalized.some((line) => line.startsWith("--- "));
  const hasNew = normalized.some((line) => line.startsWith("+++ "));
  if (!hasOld || !hasNew) {
    const filePath = expectedFile.replace(/^\/+/, "");
    if (!hasOld) normalized.unshift(`--- a/${filePath}`);
    if (!hasNew) {
      const oldIdx = normalized.findIndex((line) => line.startsWith("--- "));
      normalized.splice(oldIdx + 1, 0, `+++ b/${filePath}`);
    }
  }

  let result = normalized.join("\n");
  if (!result.endsWith("\n")) {
    result += "\n";
  }
  return result;
}

function expandPatchProposals(
  proposals: AgentProposedPatch[],
): AgentProposedPatch[] {
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

function splitMultiFilePatch(
  patchText: string,
): Array<{ file: string; patch: string }> {
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
