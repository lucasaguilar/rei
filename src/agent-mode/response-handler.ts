import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { stripThinkingBlock } from "../core/helpers/turn-message.helpers.js";

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




/**
 * Extracts <edit> blocks representing Search & Replace operations.
 */
export function extractSREdits(response: string): AgentSREdit[] {
  const edits: AgentSREdit[] = [];
  const editRegex = /<edit\s+file="([^"]+)">([\s\S]*?)<\/edit>/gi;
  const matches = [...stripThinkingBlock(response).matchAll(editRegex)];

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

/**
 * Extracts <create file="...">...</create> blocks for file creation.
 */
export function extractCreateFileRequests(
  response: string,
): Array<{ file: string; content: string }> {
  const creates: Array<{ file: string; content: string }> = [];
  const createRegex = /<create\s+file="([^"]+)">([\s\S]*?)<\/create>/gi;
  const matches = [...response.matchAll(createRegex)];
  for (const match of matches) {
    const file = match[1].trim();
    const content = normalizeBlockContent(match[2]);
    creates.push({ file, content });
  }
  return creates;
}
