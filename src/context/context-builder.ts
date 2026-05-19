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
  buildCallerFilesContext,
  buildRagNodeSnippets,
  buildRepoSummary,
} from "./helpers/context-builder.helpers.js";
import { extractExplicitPathHints } from "../workspace/file-selector.js";
import { ENABLE_SEMANTIC_RAG_SEARCH } from "./constants/context-builder.constants.js";

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
  const repoSummary = await buildRepoSummary({
    workspacePath,
    fileCount: files.length,
  });

  // RAG semantic search: if an index exists, find the most relevant AST nodes first
  let ragResults: RagSearchResult[] | undefined;
  const ragFilePaths = new Set<string>();

  if (ENABLE_SEMANTIC_RAG_SEARCH && hasRagIndex(workspacePath)) {
    try {
      ragResults = await searchRag(workspacePath, userInput, 10);
      for (const r of ragResults) {
        ragFilePaths.add(r.metadata.filePath);
      }
    } catch {
      // RAG is best-effort — if it fails, fall back to the heuristic selector
    }
  }

  // Merge RAG hits with the heuristic selector.
  const heuristicSelected = selectRelevantFiles(files, userInput, mode);
  const mergedMap = new Map<string, number>();

  for (let i = 0; i < heuristicSelected.length; i += 1) {
    const file = heuristicSelected[i];
    mergedMap.set(file.path, file.score + Math.max(0, 8 - i));
  }

  if (ragResults && ragResults.length > 0) {
    for (let i = 0; i < ragResults.length; i += 1) {
      const hit = ragResults[i];
      const ragRankBoost = Math.max(0, 14 - i * 2);
      const ragScoreBoost = Math.max(0, Math.round(hit.score * 20));
      const current = mergedMap.get(hit.metadata.filePath) ?? 0;
      mergedMap.set(
        hit.metadata.filePath,
        current + ragRankBoost + ragScoreBoost,
      );
    }
  }

  // Detect files explicitly mentioned in the user input
  const explicitPathHints = extractExplicitPathHints(userInput).map((p) =>
    p.toLowerCase(),
  );

  const top5: Array<{ path: string; score: number }> = Array.from(
    mergedMap.entries(),
  )
    .map(([p, s]) => ({ path: p, score: s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Force-include any explicitly mentioned file that scored out of top-5
  const top5Paths = new Set(top5.map((f) => f.path.toLowerCase()));
  const forcedEntries: Array<{ path: string; score: number }> = [];

  if (explicitPathHints.length > 0) {
    for (const file of files) {
      const filePathLower = file.path.toLowerCase();
      const isHinted = explicitPathHints.some(
        (hint) =>
          filePathLower === hint ||
          filePathLower.endsWith(hint) ||
          hint.endsWith(filePathLower),
      );
      if (isHinted && !top5Paths.has(filePathLower)) {
        forcedEntries.push({ path: file.path, score: 999 });
      }
    }
  }

  const mergedPaths = [...top5, ...forcedEntries];

  const relevantFiles = await Promise.all(
    mergedPaths.map(async (f) => {
      // Always include full content for explicitly mentioned files
      const isExplicitMention = explicitPathHints.some((hint) => {
        const filePathLower = f.path.toLowerCase();
        return (
          filePathLower === hint ||
          filePathLower.endsWith(hint) ||
          hint.endsWith(filePathLower)
        );
      });
      const preview = await readFilePreview(
        path.join(workspacePath, f.path),
        isExplicitMention ? PREVIEW_MAX_CHARS_FULL : PREVIEW_MAX_CHARS_AGENT,
      );
      return {
        path: f.path,
        score: f.score,
        preview,
      };
    }),
  );

  const callerFiles = await buildCallerFilesContext({
    workspacePath,
    userInput,
    scannedFiles: files,
    alreadyIncludedPaths: new Set(mergedPaths.map((file) => file.path)),
  });

  if (params.knowledgeOrchestrator) {
    params.onStatus?.("fetching_external_knowledge");
  }

  const externalKnowledge = params.knowledgeOrchestrator
    ? await params.knowledgeOrchestrator.getExternalKnowledge(userInput)
    : [];

  const ragNodeSnippets = buildRagNodeSnippets({ workspacePath, ragResults });

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
