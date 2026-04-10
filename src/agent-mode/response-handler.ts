import type { AgentSREdit } from "../contracts/agent-interaction.types.js";

function normalizeBlockContent(raw: string): string {
  let content = raw.replace(/\r\n/g, "\n");

  // Models sometimes wrap search/replace bodies in markdown fences.
  content = content.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n/, "");
  content = content.replace(/\n\s*```\s*$/, "");
  content = content.replace(/^\s*```[a-zA-Z0-9_-]*\s*/, "");
  content = content.replace(/\s*```\s*$/, "");

  // Ensure consistent backslash handling to prevent accumulation
  content = content.replace(/\\\\/g, "\\"); // Normalize double backslashes

  return content.replace(/^\n/, "").replace(/\n$/, "");
}

function compactPreview(raw: string, maxChars = 160): string {
  const oneLine = raw
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > maxChars
    ? `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`
    : oneLine;
}

import { formatCodeDiff } from '../cli/markdown-renderer.js';

export function formatSREditsForLog(edits: AgentSREdit[]): Array<{
  file: string;
  searchLines: number;
  replaceLines: number;
  searchPreview: string;
  replacePreview: string;
  diffPreview: string;
}> {
  return edits.map((edit) => ({
    file: edit.file,
    searchLines: edit.search.split("\n").length,
    replaceLines: edit.replace.split("\n").length,
    searchPreview: compactPreview(edit.search),
    replacePreview: compactPreview(edit.replace),
    diffPreview: formatCodeDiff(edit.search, edit.replace),
  }));
}

/**
 * Extracts <request_files> tags from the agent response.
 */
export function extractFileRequests(response: string): string[] {
  const matches = [
    ...response.matchAll(/<request_files>(.*?)<\/request_files>/gs),
  ];
  const files = new Set<string>();
  for (const match of matches) {
    const list = match[1].split(",");
    for (const item of list) {
      const trimmed = item.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return Array.from(files);
}

/**
 * Extracts <edit> blocks representing Search & Replace operations.
 */
export function extractSREdits(response: string): AgentSREdit[] {
  const edits: AgentSREdit[] = [];
  const editRegex = /<edit\s+file="([^"]+)">([\s\S]*?)<\/edit>/gi;
  const matches = [...response.matchAll(editRegex)];

  for (const match of matches) {
    const file = match[1].trim();
    const inner = match[2];

    const searchMatch = inner.match(/<search>([\s\S]*?)<\/search>/i);
    const replaceMatch = inner.match(
      /<replace>([\s\S]*?)(?:<\/replace>|<\/search>|$)/i,
    );

    if (searchMatch && replaceMatch) {
      edits.push({
        file,
        description: "Search and replace block",
        search: normalizeBlockContent(searchMatch[1]),
        replace: normalizeBlockContent(replaceMatch[1]),
      });
    }
  }
  return edits;
}
