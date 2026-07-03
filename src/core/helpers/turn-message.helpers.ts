import type {
  TurnContext,
  RagNodeSnippet,
} from "../../context/context-builder.js";
import { preserveThinkingEnabled } from "../../config/model-runtime.js";

const FILE_TREE_HEADER = "### PROJECT FILE TREE";
/**
 * ~3000 tokens ≈ 12000 chars. The file tree is STABLE across turns (repo structure changes rarely),
 * so it caches on the server after the first turn — a one-time prefill cost, not per-turn. Worth it:
 * the model must see EVERY filename or it wrongly concludes unseen files "don't exist". A mid-size
 * repo (~400 files) fits the grouped-by-dir view within this budget; larger repos degrade gracefully.
 */
const DEFAULT_TREE_CHAR_BUDGET = 12000;

/**
 * Renders the scanned workspace files as a compact, deterministic path listing so
 * the model knows the real repo layout and never has to guess paths (which wastes
 * agent turns rediscovering structure via `find`). Unlike the RAG skeleton map this
 * is language-independent — it never fails on non-English queries.
 *
 * Capped to a char budget: when the full listing is too big it degrades to
 * directory-level entries with file counts, and finally truncates.
 */
export function buildProjectFileTree(
  files: { path: string }[],
  charBudget: number = DEFAULT_TREE_CHAR_BUDGET,
): string {
  if (!files || files.length === 0) return "";

  const paths = files.map((f) => f.path).sort();

  // 1. Full listing if it fits.
  const full = paths.join("\n");
  if (full.length <= charBudget) {
    return `${FILE_TREE_HEADER}\n\n${full}`;
  }

  // 2. Too big: group filenames by directory — compact (the dir prefix is shared) but STILL LISTS
  // EVERY FILENAME. Never collapse to bare counts: the model must be able to see that a file exists,
  // otherwise it wrongly concludes files it can't see "don't exist" and asks the user / skips them.
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "." : p.slice(0, slash);
    const name = slash === -1 ? p : p.slice(slash + 1);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(name);
  }
  const grouped = [...byDir.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, names]) => `${dir}/: ${names.join(", ")}`)
    .join("\n");
  if (grouped.length <= charBudget) {
    return `${FILE_TREE_HEADER} (grouped by directory — ${paths.length} files)\n\n${grouped}`;
  }

  // 3. Still too big for even the grouped view: truncate, and tell the model how to see the rest.
  return (
    `${FILE_TREE_HEADER} (truncated — ${paths.length} files total; ` +
    `use run_command \`ls <dir>\` / \`git ls-files\` to list the rest)\n\n${grouped.slice(0, charBudget)}\n…`
  );
}

export function buildTurnUserMessage(params: {
  userInput: string;
  context: TurnContext;
  repositorySkeletonMap?: string;
  projectFileTree?: string;
}): string {
  const { userInput, context, repositorySkeletonMap, projectFileTree } = params;
  const lines: string[] = [];

  // Dynamic repo map goes at the top of the user message — NOT in the system message.
  // This keeps the system message byte-identical across turns, preserving the Ollama KV cache prefix.
  if (repositorySkeletonMap) {
    lines.push(repositorySkeletonMap);
    lines.push(``);
  }

  // Deterministic file tree: tells the model exactly where files live so it reads
  // the right paths on the first try instead of guessing. Always present (cheap).
  if (projectFileTree) {
    lines.push(projectFileTree);
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

export function buildStageCompletionMessage(stageNum: number, totalStages: number, ansi = false): string {
  const isLast = totalStages > 0 && stageNum >= totalStages;
  if (isLast) {
    return ansi
      ? `\n\n\x1b[32m✅ Stage ${stageNum} completed. Plan complete! All ${totalStages} stages done.\x1b[0m\n`
      : `\n\n✅ Stage ${stageNum} completed. Plan complete! All ${totalStages} stages done.`;
  }
  return ansi
    ? `\n\n\x1b[32m✅ Stage ${stageNum} completed. Run \x1b[1m/runplan stage ${stageNum + 1}\x1b[0m\x1b[32m to continue.\x1b[0m\n`
    : `\n\n✅ Stage ${stageNum} completed. Run /runplan stage ${stageNum + 1} to continue.`;
}

export function extractStageNumberFromPrompt(prompt: string): number | null {
  const match = prompt.match(/\[RUNPLAN STAGE (\d+)\]/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Returns true when an agent response indicates a stage completed successfully.
 * Covers: patches applied, files written, files created, commands run, or
 * any non-error text response (model confirmed completion in prose).
 */
export function isStageSuccessful(response: string): boolean {
  if (!response.trim()) return false;
  // Explicit failure markers
  const failureMarkers = [
    "could not complete",
    "failed to apply",
    "validation failed",
    "REI could not complete",
  ];
  if (failureMarkers.some((m) => response.toLowerCase().includes(m.toLowerCase()))) {
    return false;
  }
  // Explicit success markers
  const successMarkers = [
    "patch(es) applied directly",
    "file(s) written",
    "file created",
    "successfully created",
    "successfully applied",
    "stage complete",
    "task complete",
    "done",
  ];
  if (successMarkers.some((m) => response.toLowerCase().includes(m.toLowerCase()))) {
    return true;
  }
  // If the model produced a non-empty prose response without failure markers,
  // treat it as successful — the agent loop already validated before returning.
  return response.trim().length > 50;
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

/**
 * Cleans an assistant response for SESSION-HISTORY storage (i.e. what gets
 * re-sent to the model on subsequent turns). This is the opt-in lever for
 * "preserve thinking": when REI_PRESERVE_THINKING=true, the <think> reasoning
 * is kept in the stored content so reasoning models (e.g. Qwen3.6 with
 * "Preserve Thinking") receive their prior reasoning back. Default: strip it
 * (recommended for most models — avoids context bloat and repetition loops).
 *
 * NOTE: this only governs HISTORY/context. User-facing display always strips
 * <think> independently (CLI buffer + stripThinkingBlock on yields), so
 * enabling this never leaks raw reasoning tags to the screen.
 */
/**
 * Strips native function-call syntax (`<tool_call>`, `<function>`) that tool-trained
 * models (e.g. qwen-coding) leak as TEXT on the XML (ask/planning) path. These are NOT
 * REI tags: REI never parses them into actions — it discards them. They must never reach
 * the visible answer, the saved history, or the model on the next turn, because tool-aware
 * chat templates (notably Ollama serving a `-coding` model) try to JSON-parse them and fail
 * with "Value looks like object, but can't find closing '}' symbol" (400). Real prose and
 * REI's own action tags (`<execute_command>`, `<edit>`, …) are left untouched.
 *
 * Single source of truth — reused by token-streamer, input-turn, stripAllActionTags and
 * cleanResponseForHistory.
 */
export function stripNativeToolSyntax(text: string): string {
  return text
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function\b[\s\S]*?<\/function>/gi, "");
}

export function cleanResponseForHistory(content: string): string {
  // Always strip leaked native tool-call syntax — even with preserve-thinking on. It carries
  // zero information (the real intent already lives in REI's XML tags) and poisons tool-aware
  // templates on the NEXT turn. Preserving reasoning must never mean preserving broken tool calls.
  let clean = stripNativeToolSyntax(content);
  // Also strip EXECUTION request tags (request_files / execute_command / call_tool): they were
  // already acted upon this turn (the fetched file / command output is appended separately), so
  // keeping the raw tag only leaks it into the saved/visible answer and wastes context next turn.
  // (Agent file-op tags <edit>/<create>/<wholefile> are intentionally NOT stripped — message-builder
  // relies on them to classify agent messages.)
  clean = clean
    .replace(/<request_files>[\s\S]*?(<\/request_files>|$)/gi, "")
    .replace(/<execute_command>[\s\S]*?(<\/execute_command>|$)/gi, "")
    .replace(/<call_tool\b[\s\S]*?(<\/call_tool>|$)/gi, "");
  // DEFAULT OFF: strip the <think> block from stored history unless preservation is opted in.
  if (!preserveThinkingEnabled()) {
    return stripThinkingBlock(clean);
  }
  return clean.trim();
}

