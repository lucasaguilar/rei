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
  isExplicitContentRequest,
} from "./helpers/context-builder.helpers.js";

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
    ...heuristicSelected,
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
