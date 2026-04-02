import * as fs from "fs/promises";
import * as path from "path";
import { jsonrepair } from "jsonrepair";
import type { ChatSession } from "../../chat/types.js";
import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { generateUnifiedDiff } from "../../tools/patch-generator.js";
import { sanitizeAgentJsonText } from "./response-json.helpers.js";
import type { SearchReplaceBlock } from "../models/patch.types.js";

export async function synthesizePatchesFromContext(params: {
  provider: ModelProvider;
  messagesForModel: ChatSession["messages"];
  workspacePath: string;
}): Promise<AgentProposedPatch[]> {
  const { provider, messagesForModel, workspacePath } = params;
  const lastUserMessage = [...messagesForModel]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUserMessage) return [];

  const contextMessages = messagesForModel.filter(
    (message) => message.role === "user" || message.role === "assistant",
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

  const parsed = parseJsonObject(
    await provider.completeChat(synthesisMessages),
  );
  if (!parsed || !Array.isArray(parsed.edits)) return [];

  const edits: SearchReplaceBlock[] = [];
  for (const item of parsed.edits) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const file = typeof candidate.file === "string" ? candidate.file : "";
    const search = typeof candidate.search === "string" ? candidate.search : "";
    const replace =
      typeof candidate.replace === "string" ? candidate.replace : "";
    if (!file || !search) continue;

    edits.push({
      file,
      search,
      replace,
      description:
        typeof candidate.description === "string" ? candidate.description : "",
    });
  }

  return buildPatchesFromEdits(edits, workspacePath);
}

export async function buildPatchesFromEdits(
  edits: SearchReplaceBlock[],
  workspacePath: string,
): Promise<AgentProposedPatch[]> {
  const editsByFile = new Map<string, SearchReplaceBlock[]>();
  for (const edit of edits) {
    const existing = editsByFile.get(edit.file) ?? [];
    existing.push(edit);
    editsByFile.set(edit.file, existing);
  }

  const patches: AgentProposedPatch[] = [];

  for (const [file, fileEdits] of editsByFile) {
    const absPath = path.join(workspacePath, file);
    let before: string;
    try {
      before = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    let after = before;
    const appliedDescriptions: string[] = [];

    for (const edit of fileEdits) {
      const normalizedAfter = after.replace(/\r\n/g, "\n");
      const normalizedSearch = edit.search.replace(/\r\n/g, "\n");
      const firstOccurrence = normalizedAfter.indexOf(normalizedSearch);
      if (firstOccurrence === -1) {
        continue;
      }

      const secondOccurrence = normalizedAfter.indexOf(
        normalizedSearch,
        firstOccurrence + 1,
      );
      if (secondOccurrence !== -1) {
        continue;
      }

      after =
        normalizedAfter.slice(0, firstOccurrence) +
        edit.replace.replace(/\r\n/g, "\n") +
        normalizedAfter.slice(firstOccurrence + normalizedSearch.length);

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
