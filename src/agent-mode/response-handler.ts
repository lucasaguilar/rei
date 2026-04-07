import type { AgentSREdit } from "../contracts/agent-interaction.types.js";

/**
 * Extracts <request_files> tags from the agent response.
 */
export function extractFileRequests(response: string): string[] {
  const matches = [...response.matchAll(/<request_files>(.*?)<\/request_files>/gs)];
  const files = new Set<string>();
  for (const match of matches) {
    const list = match[1].split(',');
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
    const replaceMatch = inner.match(/<replace>([\s\S]*?)(?:<\/replace>|<\/search>|$)/i);
    
    if (searchMatch && replaceMatch) {
      edits.push({
        file,
        description: "Search and replace block",
        search: searchMatch[1].replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
        replace: replaceMatch[1].replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
      });
    }
  }
  return edits;
}
