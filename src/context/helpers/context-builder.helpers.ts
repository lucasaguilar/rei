import * as fs from "fs";
import * as path from "path";
import type { FileMeta } from "../../workspace/workspace-scanner.js";
import {
  PREVIEW_MAX_CHARS_AGENT,
  readFilePreview,
} from "../../workspace/file-preview.js";
import type { RagSearchResult } from "../rag/rag-indexer.js";
import {
  extractSymbolHints,
  findSymbolCallers,
  rankCallerFiles,
} from "../caller-graph.js";
import {
  CHANGE_INTENT_PATTERN,
  EXPLICIT_CONTENT_REQUEST_PATTERN,
  MAX_CALLER_CONTEXT_FILES,
  MAX_CALLER_SEARCH_RESULTS,
  MAX_RAG_NODE_SNIPPET_CHARS,
  PROJECT_MARKERS,
} from "../constants/context-builder.constants.js";
import type { RagNodeSnippet } from "../context-builder.js";

export interface CallerContextFile {
  path: string;
  symbols: string[];
  preview: string;
}

export function isExplicitContentRequest(userInput: string): boolean {
  const lower = userInput.toLowerCase();
  return EXPLICIT_CONTENT_REQUEST_PATTERN.test(lower);
}

/**
 * Directories that exist in a repository without describing it.
 *
 * The cost is trivial — four tokens for "node_modules" — but the signal is not: listing build
 * output and dependencies as part of the project's shape invites the model to go looking there.
 * `bin`, `docs`, `prompts`, `src` say what this repo IS; these say what a build left behind.
 */
const NON_STRUCTURAL_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target", // rust / java
  "vendor", // php / go
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

export async function buildRepoSummary(params: {
  workspacePath: string;
  fileCount: number;
}): Promise<string> {
  const { workspacePath, fileCount } = params;
  const lines: string[] = [];

  const detectedMarkers = PROJECT_MARKERS.filter((marker) =>
    fs.existsSync(path.join(workspacePath, marker)),
  );
  if (detectedMarkers.length > 0) {
    lines.push(`Project markers: ${detectedMarkers.join(", ")}`);
  }

  const topLevelDirs: string[] = [];
  try {
    const entries = await fs.promises.readdir(workspacePath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !NON_STRUCTURAL_DIRS.has(entry.name)
      ) {
        topLevelDirs.push(entry.name);
      }
    }
  } catch {
    // ignore
  }

  if (topLevelDirs.length > 0) {
    lines.push(`Top-level folders: ${topLevelDirs.join(", ")}`);
  }

  lines.push(`Total files scanned: ${fileCount}`);
  return lines.join("\n");
}

export async function buildCallerFilesContext(params: {
  workspacePath: string;
  userInput: string;
  scannedFiles: FileMeta[];
  alreadyIncludedPaths: Set<string>;
}): Promise<CallerContextFile[]> {
  const { workspacePath, userInput, scannedFiles, alreadyIncludedPaths } =
    params;
  const callerFiles: CallerContextFile[] = [];

  if (!CHANGE_INTENT_PATTERN.test(userInput)) {
    return callerFiles;
  }

  const symbolHints = extractSymbolHints(userInput);
  if (symbolHints.length === 0) {
    return callerFiles;
  }

  const callerRefs = findSymbolCallers({
    workspacePath,
    symbolNames: symbolHints,
    scannedFiles,
    maxResults: MAX_CALLER_SEARCH_RESULTS,
  });

  const symbolsByFile = new Map<string, string[]>();
  for (const ref of callerRefs) {
    const existing = symbolsByFile.get(ref.filePath) ?? [];
    if (!existing.includes(ref.symbolName)) {
      existing.push(ref.symbolName);
    }
    symbolsByFile.set(ref.filePath, existing);
  }

  const rankedCallerPaths = rankCallerFiles(callerRefs);
  for (const callerPath of rankedCallerPaths.slice(
    0,
    MAX_CALLER_CONTEXT_FILES,
  )) {
    if (alreadyIncludedPaths.has(callerPath)) continue;

    try {
      const preview = await readFilePreview(
        path.join(workspacePath, callerPath),
        PREVIEW_MAX_CHARS_AGENT,
      );
      callerFiles.push({
        path: callerPath,
        symbols: symbolsByFile.get(callerPath) ?? [],
        preview,
      });
    } catch {
      // File unreadable — skip
    }
  }

  return callerFiles;
}

export function buildRagNodeSnippets(params: {
  workspacePath: string;
  ragResults?: RagSearchResult[];
}): RagNodeSnippet[] {
  const { workspacePath, ragResults } = params;
  const snippets: RagNodeSnippet[] = [];
  if (!ragResults || ragResults.length === 0) {
    return snippets;
  }

  for (const hit of ragResults) {
    const { filePath, nodeType, nodeName, startLine, endLine } = hit.metadata;
    if (!startLine || !endLine || endLine <= 0) continue;

    try {
      const absPath = path.join(workspacePath, filePath);
      const fileContent = fs.readFileSync(absPath, "utf8");
      const allLines = fileContent.split("\n");
      const codeLines = allLines.slice(startLine - 1, endLine);
      const code = codeLines.join("\n").slice(0, MAX_RAG_NODE_SNIPPET_CHARS);

      snippets.push({
        filePath,
        nodeType,
        nodeName,
        startLine,
        endLine,
        score: hit.score,
        code,
      });
    } catch {
      // File may have been deleted since indexing — skip silently
    }
  }

  return snippets;
}
