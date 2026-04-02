import * as fs from "fs";
import * as path from "path";
import type { SessionMode } from "../chat/types.js";
import type { KnowledgeChunk } from "../knowledge/types.js";
import {
  scanWorkspace,
  type FileMeta,
} from "../workspace/workspace-scanner.js";
import { selectRelevantFiles } from "../workspace/file-selector.js";
import {
  readFilePreview,
  PREVIEW_MAX_CHARS_AGENT,
  PREVIEW_MAX_CHARS_DEFAULT,
  PREVIEW_MAX_CHARS_FULL,
} from "../workspace/file-preview.js";
import {
  searchRag,
  hasRagIndex,
  type RagSearchResult,
} from "./rag/rag-indexer.js";
import {
  extractSymbolHints,
  findSymbolCallers,
  rankCallerFiles,
} from "./caller-graph.js";

export type RagNodeSnippet = {
  filePath: string;
  nodeType: string;
  nodeName: string;
  startLine: number;
  endLine: number;
  score: number;
  code: string;
};

export type TurnContext = {
  workspacePath: string;
  repoSummary: string;
  relevantFiles: Array<{
    path: string;
    score: number;
    preview: string;
  }>;
  externalKnowledge: KnowledgeChunk[];
  ragResults?: RagSearchResult[];
  ragNodeSnippets?: RagNodeSnippet[];
  /** Files that reference the symbols mentioned in the user prompt (for cascade changes) */
  callerFiles?: Array<{ path: string; symbols: string[]; preview: string }>;
};

const PROJECT_MARKERS = [
  "package.json",
  "tsconfig.json",
  "angular.json",
  "README.md",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
];

export async function buildTurnContext(params: {
  workspacePath: string;
  userInput: string;
  mode: SessionMode;
  scannedFiles?: FileMeta[];
  knowledgeOrchestrator?: import("../knowledge/orchestrator.js").KnowledgeOrchestrator;
  onStatus?: (
    status: import("../core/models/agent.types.js").TurnStatus,
  ) => void;
}): Promise<TurnContext> {
  const { workspacePath, userInput, mode, scannedFiles } = params;

  const files = scannedFiles ?? scanWorkspace(workspacePath);
  const repoSummary = await buildRepoSummary(
    workspacePath,
    files.map((f) => f.path),
  );

  // RAG semantic search: if an index exists, find the most relevant AST nodes first
  let ragResults: RagSearchResult[] | undefined;
  const ragFilePaths = new Set<string>();

  if (hasRagIndex(workspacePath)) {
    try {
      ragResults = await searchRag(workspacePath, userInput, 5);
      for (const r of ragResults) {
        ragFilePaths.add(r.metadata.filePath);
      }
    } catch {
      // RAG is best-effort — if it fails, fall back to the heuristic selector
    }
  }

  // Merge RAG hits with the heuristic selector, RAG-ranked files take priority
  const heuristicSelected = selectRelevantFiles(files, userInput, mode);

  const mergedPaths: Array<{ path: string; score: number }> = [
    // RAG results first (guaranteed semantic relevance)
    ...Array.from(ragFilePaths).map((p) => ({ path: p, score: 1 })),
    // Heuristic results that weren't already included from RAG
    ...heuristicSelected.filter((f) => !ragFilePaths.has(f.path)),
  ];

  const isExplicit = isExplicitContentRequest(userInput);
  const previewMaxChars =
    mode === "agent"
      ? isExplicit
        ? PREVIEW_MAX_CHARS_FULL
        : PREVIEW_MAX_CHARS_AGENT
      : isExplicit
        ? PREVIEW_MAX_CHARS_AGENT
        : PREVIEW_MAX_CHARS_DEFAULT;

  const relevantFiles = await Promise.all(
    mergedPaths.map(async (f) => ({
      path: f.path,
      score: f.score,
      preview: await readFilePreview(
        path.join(workspacePath, f.path),
        previewMaxChars,
      ),
    })),
  );

  // Caller graph: when the input looks like a change request, find files that
  // reference the symbols mentioned in the prompt and pre-load them into context.
  const callerFiles: Array<{
    path: string;
    symbols: string[];
    preview: string;
  }> = [];
  const isChangeIntent =
    /\b(add|change|modify|update|fix|implement|create|remove|delete|refactor|agreg|cambi|modific|actualiz|arregl|implement|cre[ar]|elimin|borr)\w*/i.test(
      userInput,
    );

  if (isChangeIntent) {
    const symbolHints = extractSymbolHints(userInput);
    if (symbolHints.length > 0) {
      const callerRefs = findSymbolCallers({
        workspacePath,
        symbolNames: symbolHints,
        scannedFiles: files,
        maxResults: 15,
      });

      // Group symbols by file for the context entry
      const symbolsByFile = new Map<string, string[]>();
      for (const ref of callerRefs) {
        const existing = symbolsByFile.get(ref.filePath) ?? [];
        if (!existing.includes(ref.symbolName)) existing.push(ref.symbolName);
        symbolsByFile.set(ref.filePath, existing);
      }

      const rankedCallerPaths = rankCallerFiles(callerRefs);
      const alreadyIncluded = new Set(mergedPaths.map((f) => f.path));

      for (const callerPath of rankedCallerPaths.slice(0, 5)) {
        if (alreadyIncluded.has(callerPath)) continue;
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
    }
  }

  if (params.knowledgeOrchestrator) {
    params.onStatus?.("fetching_external_knowledge");
  }

  const externalKnowledge = params.knowledgeOrchestrator
    ? await params.knowledgeOrchestrator.getExternalKnowledge(userInput)
    : [];

  // Extract the actual source code of each RAG-retrieved AST node by line numbers
  const ragNodeSnippets: RagNodeSnippet[] = [];
  if (ragResults && ragResults.length > 0) {
    for (const hit of ragResults) {
      const { filePath, nodeType, nodeName, startLine, endLine } = hit.metadata;
      if (!startLine || !endLine || endLine <= 0) continue;
      try {
        const absPath = path.join(workspacePath, filePath);
        const fileContent = fs.readFileSync(absPath, "utf8");
        const allLines = fileContent.split("\n");
        // NOTE: ts-morph line numbers are 1-indexed; slice is 0-indexed
        const codeLines = allLines.slice(startLine - 1, endLine);
        const code = codeLines.join("\n").slice(0, 3000); // cap to avoid overloading context
        ragNodeSnippets.push({
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
  }

  return {
    workspacePath,
    repoSummary,
    relevantFiles,
    externalKnowledge,
    ragResults,
    ragNodeSnippets,
    callerFiles: callerFiles.length > 0 ? callerFiles : undefined,
  };
}

function isExplicitContentRequest(userInput: string): boolean {
  const lower = userInput.toLowerCase();
  return /c[oó]digo exacto|exact code|full code|complete code|contenido completo|c[oó]digo completo|full content|complete file|todas las funciones|all functions|show.{0,15}code|mostrame.{0,25}c[oó]digo|dame.{0,25}c[oó]digo/.test(
    lower,
  );
}

async function buildRepoSummary(
  workspacePath: string,
  filePaths: string[],
): Promise<string> {
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
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        topLevelDirs.push(entry.name);
      }
    }
  } catch {
    // ignore
  }
  if (topLevelDirs.length > 0) {
    lines.push(`Top-level folders: ${topLevelDirs.join(", ")}`);
  }

  lines.push(`Total files scanned: ${filePaths.length}`);

  return lines.join("\n");
}
