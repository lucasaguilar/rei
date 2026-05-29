import type {
  TurnContext,
  RagNodeSnippet,
} from "../../context/context-builder.js";

export function buildTurnUserMessage(params: {
  userInput: string;
  context: TurnContext;
  repositorySkeletonMap?: string;
}): string {
  const { userInput, context, repositorySkeletonMap } = params;
  const lines: string[] = [];

  // Dynamic repo map goes at the top of the user message — NOT in the system message.
  // This keeps the system message byte-identical across turns, preserving the Ollama KV cache prefix.
  if (repositorySkeletonMap) {
    lines.push(repositorySkeletonMap);
    lines.push(``);
  }

  lines.push(`Task: ${userInput}`);
  lines.push(``);
  lines.push(`Workspace: ${context.workspacePath}`);
  lines.push(``);
  lines.push(`Repository summary:`);
  lines.push(context.repoSummary);

  if (context.ragNodeSnippets && context.ragNodeSnippets.length > 0) {
    lines.push(``);
    lines.push(
      `Semantic RAG Context — Exact code retrieved from the vector index:`,
    );
    lines.push(
      `These are the most semantically relevant AST nodes to the current task.`,
    );
    lines.push(
      `Use this code as the primary source of truth. It is exact, not truncated.`,
    );
    for (const snippet of context.ragNodeSnippets) {
      const pct = Math.round(snippet.score * 100);
      lines.push(``);
      lines.push(
        `### [${snippet.nodeType}] ${snippet.nodeName} — ${snippet.filePath}:${snippet.startLine}-${snippet.endLine} (similarity: ${pct}%)`,
      );
      lines.push("```");
      lines.push(snippet.code);
      lines.push("```");
    }
  } else if (context.ragResults && context.ragResults.length > 0) {
    lines.push(``);
    lines.push(`Semantic RAG Context (top matches from vector index):`);
    for (const hit of context.ragResults) {
      const pct = Math.round(hit.score * 100);
      lines.push(
        `  - [${hit.metadata.nodeType}] ${hit.metadata.nodeName} in ${hit.metadata.filePath} (similarity: ${pct}%)`,
      );
    }
  }

  if (context.externalKnowledge && context.externalKnowledge.length > 0) {
    lines.push(``);
    lines.push(`External Official Documentation:`);
    lines.push(
      `These are officially sourced technical references related to the user's task.`,
    );
    context.externalKnowledge.forEach((knowledge, idx) => {
      lines.push(`${idx + 1}. [${knowledge.domain}] ${knowledge.title}`);
      lines.push(`   Source: ${knowledge.url}`);
      lines.push(
        `   Summary:\n   ${knowledge.content.split("\\n").join("\\n   ")}`,
      );
      lines.push(``);
    });
  }

  if (context.callerFiles && context.callerFiles.length > 0) {
    lines.push(``);
    lines.push(
      `Caller Graph — Files that reference the symbols mentioned in this task:`,
    );
    lines.push(
      `These files may need to be updated as part of a cascade change.`,
    );
    lines.push(
      `They are included here so you can propose patches for ALL affected files in one response.`,
    );
    for (const caller of context.callerFiles) {
      lines.push(``);
      lines.push(
        `--- ${caller.path} (references: ${caller.symbols.join(", ")}) ---`,
      );
      lines.push(caller.preview);
    }
  }

  if (context.relevantFiles.length > 0) {
    lines.push(``);
    lines.push(
      `The following files are ALREADY included in this message. Do NOT request them via <request_files> tags:`,
    );
    for (const file of context.relevantFiles) {
      lines.push(`  - ${file.path}`);
    }
    if (context.callerFiles && context.callerFiles.length > 0) {
      for (const caller of context.callerFiles) {
        lines.push(`  - ${caller.path}`);
      }
    }
    lines.push(``);
    lines.push(
      `Important: The file excerpts below may be partial or truncated.\nUse only the visible content. Do not reconstruct omitted code.`,
    );
    lines.push(`Relevant files:`);
    for (const file of context.relevantFiles) {
      lines.push(``);
      lines.push(`--- ${file.path} (score: ${file.score}) ---`);
      lines.push(file.preview);
    }
  }

  return lines.join("\n");
}

/**
 * Heuristic to detect when a non-agent mode response looks like an agent
 * JSON contract object. Checks for the structural fingerprint of AgentResponse
 * (top-level keys "version", "mode", "actions") without full parsing.
 */
export function looksLikeAgentJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) return false;
  return (
    /"version"\s*:/.test(trimmed) &&
    /"mode"\s*:\s*"agent"/.test(trimmed) &&
    /"actions"\s*:/.test(trimmed)
  );
}

export function extractStageNumberFromPrompt(prompt: string): number | null {
  const match = prompt.match(/\[RUNPLAN STAGE (\d+)\]/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Strips all execution XML action tags (<execute_command>, <call_tool>, <request_files>)
 * and model reasoning blocks (<think>) from a response string so they are never
 * persisted into session history and re-sent to the LLM as wasted context tokens.
 */
export function stripActionTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")  // strip model reasoning — never send back
    .replace(/<execute_command>[\s\S]*?(<\/execute_command>|$)/gi, "")
    .replace(/<call_tool\s+name="[^"]+">[\s\S]*?(<\/call_tool>|$)/gi, "")
    .replace(/<request_files>[\s\S]*?(<\/request_files>|$)/gi, "")
    .trim();
}

/**
 * Strips ONLY the model reasoning blocks (<think>) from a response string,
 * preserving all action/XML tags so the agent/planning modes maintain their full context.
 */
export function stripThinkingBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
}

