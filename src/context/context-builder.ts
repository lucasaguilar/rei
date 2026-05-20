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
import { smartCompress } from "../chat/helpers/chat.helpers.js";
import { extractExplicitPathHints } from "../workspace/file-selector.js";
import {
  ENABLE_SEMANTIC_RAG_SEARCH,
  MAX_RELEVANT_FILES_AGENT,
  MAX_RELEVANT_FILES_NON_AGENT,
  MIN_RAG_SCORE_FOR_FILE_PREVIEW,
  ON_DEMAND_FILE_CONTEXT,
} from "./constants/context-builder.constants.js";

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

  // Run repoSummary and RAG search in parallel — they are independent
  const [repoSummary, ragResults] = await Promise.all([
    buildRepoSummary({ workspacePath, fileCount: files.length }),
    (async (): Promise<RagSearchResult[] | undefined> => {
      if (!ENABLE_SEMANTIC_RAG_SEARCH || !hasRagIndex(workspacePath))
        return undefined;
      try {
        return await searchRag(workspacePath, userInput, 10);
      } catch {
        // RAG is best-effort — if it fails, fall back to the heuristic selector
        return undefined;
      }
    })(),
  ]);

  const ragMaxScoreByFile = new Map<string, number>();
  if (ragResults) {
    for (const hit of ragResults) {
      const filePath = hit.metadata.filePath.toLowerCase();
      const existing =
        ragMaxScoreByFile.get(filePath) ?? Number.NEGATIVE_INFINITY;
      if (hit.score > existing) {
        ragMaxScoreByFile.set(filePath, hit.score);
      }
    }
  }

  const rawSnippets = buildRagNodeSnippets({ workspacePath, ragResults });
  const ragSnippetFilePaths = new Set(
    rawSnippets.map((snippet) => snippet.filePath.toLowerCase()),
  );

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

  const maxRelevantFiles =
    mode === "agent" ? MAX_RELEVANT_FILES_AGENT : MAX_RELEVANT_FILES_NON_AGENT;

  const topRanked: Array<{ path: string; score: number }> = Array.from(
    mergedMap.entries(),
  )
    .map(([p, s]) => ({ path: p, score: s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRelevantFiles);

  // Force-include any explicitly mentioned file that scored out of top ranked list.
  const topRankedPaths = new Set(topRanked.map((f) => f.path.toLowerCase()));
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
      if (isHinted && !topRankedPaths.has(filePathLower)) {
        forcedEntries.push({ path: file.path, score: 999 });
      }
    }
  }

  const mergedPaths = [...topRanked, ...forcedEntries];

  const relevantFiles = (
    await Promise.all(
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

        const filePathLower = f.path.toLowerCase();

        if (!isExplicitMention) {
          if (ON_DEMAND_FILE_CONTEXT) {
            return null;
          }

          // If exact semantic code is already attached for this file, skip the broader file preview.
          if (ragSnippetFilePaths.has(filePathLower)) {
            return null;
          }

          // When semantic RAG is available, only include previews for strong matches.
          if (ragResults && ragResults.length > 0) {
            const ragScore = ragMaxScoreByFile.get(filePathLower);
            if (
              ragScore === undefined ||
              ragScore < MIN_RAG_SCORE_FOR_FILE_PREVIEW
            ) {
              return null;
            }
          }
        }

        const preview = await readFilePreview(
          path.join(workspacePath, f.path),
          isExplicitMention ? PREVIEW_MAX_CHARS_FULL : PREVIEW_MAX_CHARS_AGENT,
          !isExplicitMention,
        );
        return {
          path: f.path,
          score: f.score,
          preview,
        };
      }),
    )
  ).filter(
    (file): file is { path: string; score: number; preview: string } =>
      file !== null,
  );

  // Run all three independent async operations in parallel
  const [callerFiles, externalKnowledge, ragNodeSnippets] = await Promise.all([
    buildCallerFilesContext({
      workspacePath,
      userInput,
      scannedFiles: files,
      alreadyIncludedPaths: new Set(relevantFiles.map((file) => file.path)),
    }),
    params.knowledgeOrchestrator
      ? (params.onStatus?.("fetching_external_knowledge"),
        params.knowledgeOrchestrator.getExternalKnowledge(userInput))
      : Promise.resolve([] as KnowledgeChunk[]),
    Promise.all(
      rawSnippets.map(async (snippet) => {
        const lang = snippet.filePath.split(".").pop() ?? "";
        const code = await smartCompress(snippet.code, userInput, lang);
        return { ...snippet, code };
      }),
    ),
  ]);

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
