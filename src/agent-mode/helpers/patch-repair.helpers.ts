import * as fs from "fs/promises";
import * as path from "path";
import { jsonrepair } from "jsonrepair";
import type { ChatSession } from "../../chat/types.js";
import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { generateUnifiedDiff } from "../../tools/patch-generator.js";
import { sanitizeAgentJsonText } from "./response-json.helpers.js";
import type {
  PatchSynthesisCoverage,
  SearchReplaceBlock,
} from "../models/patch.types.js";
import type { AgentLogger } from "../../core/logger.js";

export interface PatchSynthesisResult {
  patches: AgentProposedPatch[];
  coverage: PatchSynthesisCoverage;
}

export async function synthesizePatchesFromContext(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
  logger?: AgentLogger;
}): Promise<PatchSynthesisResult> {
  const { provider, messagesForModel, workspacePath, logger } = params;
  const lastUserMessage = [...messagesForModel]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUserMessage) {
    return {
      patches: [],
      coverage: {
        rawEditCount: 0,
        acceptedEditCount: 0,
        patchCount: 0,
        droppedEdits: [],
      },
    };
  }

  const contextMessages = messagesForModel.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );

  const synthesisMessages: ChatSession["messages"] = [
    {
      role: "system",
      content: [
        "You are REI in patch synthesis mode.",
        "Generate concrete edits for the requested change.",
        "Return JSON only with this exact shape:",
        '{"edits":[{"file":"src/file.ts","description":"short reason","search":"exact lines to find","replace":"replacement lines","create":false},{"file":"src/new-file.ts","description":"create new file","create":true,"content":"full file content"}]}',
        "",
        "Rules:",
        '- For existing files, "search" must be an EXACT contiguous substring of the current file content (copy-paste precision).',
        '- For existing files, "replace" is what replaces the search block.',
        '- For new files, use {"create":true,"content":"..."} and omit search/replace.',
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

  const parsed = parseJsonObject(
    await provider.completeChat(synthesisMessages),
  );
  if (!parsed || !Array.isArray(parsed.edits)) {
    logger?.logSynthesisFailed(
      "JSON parsing failed or no edits array",
      JSON.stringify(parsed ?? {}).substring(0, 200),
    );
    return {
      patches: [],
      coverage: {
        rawEditCount: 0,
        acceptedEditCount: 0,
        patchCount: 0,
        droppedEdits: [],
      },
    };
  }

  if (parsed.edits.length === 0) {
    logger?.logSynthesisFailed(
      "Model returned empty edits array",
      "No edits provided",
    );
    return {
      patches: [],
      coverage: {
        rawEditCount: 0,
        acceptedEditCount: 0,
        patchCount: 0,
        droppedEdits: [],
      },
    };
  }

  const edits: SearchReplaceBlock[] = [];
  for (const item of parsed.edits) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const file = typeof candidate.file === "string" ? candidate.file : "";
    const search =
      typeof candidate.search === "string"
        ? unescapeLiteralNewlines(candidate.search)
        : "";
    const replace =
      typeof candidate.replace === "string"
        ? unescapeLiteralNewlines(candidate.replace)
        : "";
    const create = candidate.create === true;
    const content =
      typeof candidate.content === "string"
        ? unescapeLiteralNewlines(candidate.content)
        : "";
    if (!file) continue;
    if (!create && !search) continue;
    if (create && !content) continue;

    edits.push({
      file,
      search,
      replace,
      create,
      content,
      description:
        typeof candidate.description === "string" ? candidate.description : "",
    });
  }

  if (edits.length === 0) {
    logger?.logSynthesisFailed(
      "No valid edits extracted from model response",
      "Edits array was empty after filtering",
    );
    return {
      patches: [],
      coverage: {
        rawEditCount: parsed.edits.length,
        acceptedEditCount: 0,
        patchCount: 0,
        droppedEdits: [],
      },
    };
  }

  const result = await buildPatchesFromEdits(
    edits,
    workspacePath,
    parsed.edits.length,
  );
  if (result.patches.length > 0) {
    logger?.logPatchSynthesis(edits.length, result.patches.length);
  }
  logger?.logPatchSynthesisCoverage(result.coverage);
  return result;
}

export async function buildPatchesFromEdits(
  edits: SearchReplaceBlock[],
  workspacePath: string,
  rawEditCount = edits.length,
): Promise<PatchSynthesisResult> {
  const editsByFile = new Map<string, SearchReplaceBlock[]>();
  for (const edit of edits) {
    const existing = editsByFile.get(edit.file) ?? [];
    existing.push(edit);
    editsByFile.set(edit.file, existing);
  }

  const patches: AgentProposedPatch[] = [];
  const droppedEdits: PatchSynthesisCoverage["droppedEdits"] = [];

  for (const [file, fileEdits] of editsByFile) {
    const absPath = path.join(workspacePath, file);
    let fileExists = true;
    let before: string;
    try {
      before = await fs.readFile(absPath, "utf-8");
    } catch {
      fileExists = false;
      before = "";
    }

    let after = before;
    const appliedDescriptions: string[] = [];

    for (const edit of fileEdits) {
      if (fileExists && edit.create === true) {
        droppedEdits.push({
          file,
          description: edit.description,
          reason: "CREATE_TARGET_EXISTS",
          detail: "Create edit targeted a file that already exists.",
        });
        continue;
      }

      if (!fileExists && edit.create === true) {
        after = (edit.content ?? "").replace(/\r\n/g, "\n");
        appliedDescriptions.push(edit.description || "Create file");
        fileExists = true;
        continue;
      }

      const normalizedAfter = after.replace(/\r\n/g, "\n");
      const normalizedSearch = edit.search.replace(/\r\n/g, "\n");
      const firstOccurrence = normalizedAfter.indexOf(normalizedSearch);
      if (firstOccurrence === -1) {
        droppedEdits.push({
          file,
          description: edit.description,
          reason: "SEARCH_NOT_FOUND",
          detail: "Search block was not found in the target file.",
        });
        continue;
      }

      const secondOccurrence = normalizedAfter.indexOf(
        normalizedSearch,
        firstOccurrence + 1,
      );
      if (secondOccurrence !== -1) {
        droppedEdits.push({
          file,
          description: edit.description,
          reason: "SEARCH_AMBIGUOUS",
          detail: "Search block matched more than once in the target file.",
        });
        continue;
      }

      after =
        normalizedAfter.slice(0, firstOccurrence) +
        edit.replace.replace(/\r\n/g, "\n") +
        normalizedAfter.slice(firstOccurrence + normalizedSearch.length);

      appliedDescriptions.push(edit.description);
    }

    if (after === before) {
      if (fileEdits.length > 0 && appliedDescriptions.length === 0) {
        droppedEdits.push({
          file,
          description: "No applied edits",
          reason: "EMPTY_PATCH_RESULT",
          detail: "No edit in this file could be converted into a patch.",
        });
      }
      continue;
    }

    let diff = generateUnifiedDiff(file, before, after);
    if (!diff) {
      droppedEdits.push({
        file,
        description: appliedDescriptions.join("; ") || "Synthesized edit",
        reason: "EMPTY_PATCH_RESULT",
        detail: "Unified diff generation produced an empty patch.",
      });
      continue;
    }

    const isCreatePatch = before.length === 0;
    if (isCreatePatch) {
      diff = diff.replace(/^---\sa\/.+$/m, "--- /dev/null");
    }

    patches.push({
      file,
      patch: diff,
      description: appliedDescriptions.join("; ") || "Synthesized edit",
    });
  }

  return {
    patches,
    coverage: {
      rawEditCount,
      acceptedEditCount: edits.length,
      patchCount: patches.length,
      droppedEdits,
    },
  };
}

export function parseSearchReplacePayload(
  raw: string,
): Record<string, unknown> | null {
  return parseJsonObject(raw);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const sanitized = sanitizeAgentJsonText(raw) || raw;

  try {
    const parsed = JSON.parse(sanitized);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    try {
      const parsed = JSON.parse(jsonrepair(sanitized));
      return isJsonObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Some models double-escape newlines in JSON string values, producing literal
 * backslash-n instead of real newlines after JSON.parse. This normalizes them.
 */
function unescapeLiteralNewlines(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}
