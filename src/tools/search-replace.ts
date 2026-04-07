import type { AgentSREdit } from "../contracts/agent-interaction.types.js";

export interface SRExecutionResult {
  success: boolean;
  error?: string;
  newContent?: string;
}

/**
 * Applies a single Search & Replace block to the given text content.
 * Looks for exact string matches.
 */
export function applySearchReplace(originalContent: string, edit: AgentSREdit): SRExecutionResult {
  const searchNormalized = edit.search.replace(/\r\n/g, "\n");
  const contentNormalized = originalContent.replace(/\r\n/g, "\n");
  
  const index = contentNormalized.indexOf(searchNormalized);
  
  if (index === -1) {
    // Attempt fallback: try trimming per-line whitespace differences
    const linesSearch = searchNormalized.split("\n").map(l => l.trim());
    const linesContent = contentNormalized.split("\n");
    
    // We do a naive fallback strictly for reporting purposes right now.
    // Real fuzzy matching can be added later.
    return {
      success: false,
      error: `Could not find exact match for search block in ${edit.file}. Make sure to copy the exact text including whitespace.`
    };
  }
  
  // Enforce uniqueness constraints (optional, but good for safety)
  const lastIndex = contentNormalized.lastIndexOf(searchNormalized);
  if (index !== lastIndex) {
    return {
      success: false,
      error: `Search block matched multiple locations in ${edit.file}. Provide more context lines to make it unique.`
    };
  }
  
  const replaceNormalized = edit.replace.replace(/\r\n/g, "\n");
  const newContent = contentNormalized.slice(0, index) + replaceNormalized + contentNormalized.slice(index + searchNormalized.length);
  
  return {
    success: true,
    newContent
  };
}

/**
 * Helper to apply a batch of edits to a single file sequentially.
 */
export function applyFileEdits(originalContent: string, edits: AgentSREdit[]): SRExecutionResult {
  let currentContent = originalContent;
  
  for (const edit of edits) {
    const res = applySearchReplace(currentContent, edit);
    if (!res.success) {
      return res; // Fast fail
    }
    currentContent = res.newContent!;
  }
  
  return { success: true, newContent: currentContent };
}
