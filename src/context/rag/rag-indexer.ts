import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";
import { supportsAstIndexingExtension, getLanguageCapabilityForExtension } from "../../language/language-capabilities.js";
import { AstProviderFactory } from "../../context/ast-providers/ast-provider-factory.js";
import type { SourceFileLike, AstChunk } from "../../context/ast-providers/ast-provider.js";
import { HeuristicAstProvider } from "../../context/ast-providers/heuristic-ast-provider.js";
import { VectorStore, VectorMetadata } from "./vector-store.js";
import { generateEmbedding } from "./embedder.js";
import type { VectorSearchResult } from "./vector-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RagIndexerOptions {
  onProgress?: (indexed: number, total: number) => void;
  onDone?: (message: string) => void;
}

export interface RagSearchResult extends VectorSearchResult {
  score: number;
}

let indexingActive = false;
let indexingAbortFlag = false;

/**
 * Runs the RAG indexing in the same process using the event loop.
 * Each `await` call (embedding generation, file I/O) naturally yields
 * execution to keyboard/UI handlers, keeping the terminal responsive.
 * Safe to call multiple times — a second call aborts the previous run.
 */
export function startIndexingWorker(
  workspacePath: string,
  options: RagIndexerOptions = {},
): void {
  // NOTE: Abort any ongoing indexing before starting a new one
  if (indexingActive) {
    indexingAbortFlag = true;
  }

  runIndexing(workspacePath, options).catch((err: Error) => {
    options.onDone?.(`RAG indexing error: ${err.message}`);
  });
}

async function runIndexing(
  workspacePath: string,
  options: RagIndexerOptions,
): Promise<void> {
  indexingActive = true;
  indexingAbortFlag = false;

  const files = scanWorkspace(workspacePath);
  if (files.length === 0) {
    options.onDone?.("RAG: No files found to index.");
    indexingActive = false;
    return;
  }

  const store = new VectorStore(workspacePath);
  await store.load();

  // Smart Garbage Collection: Eliminar del vector store los archivos que ya no existen físicamente
  const activePaths = new Set(files.map((f) => f.path));
  await store.cleanupStaleFiles(activePaths);

  let indexed = 0;
  const total = files.length;

  for (const file of files) {
    // NOTE: Check abort flag before each file — allows clean cancellation
    if (indexingAbortFlag) {
      await store.save();
      options.onDone?.(`RAG indexing cancelled after ${indexed} files.`);
      indexingActive = false;
      return;
    }

    const absPath = path.resolve(workspacePath, file.path);

    if (supportsAstIndexingExtension(file.extension)) {
      let content: string | undefined;
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        // Unreadable file — skip
      }

      if (content !== undefined) {
        const languageId = getLanguageCapabilityForExtension(file.extension).id;
        const fileLike: SourceFileLike = {
          filePath: file.path,
          absoluteFilePath: absPath,
          languageId,
          content,
        };
        const provider = AstProviderFactory.resolve(fileLike);

        let astChunks: AstChunk[] = [];
        try {
          astChunks = await provider.extractChunks(fileLike);
        } catch {
          // Primary provider threw — fall back to HeuristicAstProvider (FR-8)
          try {
            astChunks = await new HeuristicAstProvider().extractChunks(fileLike);
          } catch {
            astChunks = [];
          }
        }

        const chunks =
          astChunks.length > 0
            ? astChunks.map((c) => ({
                name: c.symbolName ?? file.path,
                type: c.nodeType,
                text: c.content,
                startLine: c.startLine,
                endLine: c.endLine,
              }))
            : [
                {
                  name: file.path,
                  type: "file_chunk",
                  text: content.slice(0, 4000),
                  startLine: 1,
                  endLine: 0,
                },
              ];

        for (const chunk of chunks) {
          if (!chunk.text.trim()) continue;
          const id = `${file.path}::${chunk.type}::${chunk.name}`;
          const metadata: VectorMetadata = {
            id,
            filePath: file.path,
            nodeType: chunk.type,
            nodeName: chunk.name,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          };
          const vector = await generateEmbedding(chunk.text.slice(0, 2000));
          store.upsert(metadata, vector);
        }
      }
    } else {
      try {
        const rawText = fs.readFileSync(absPath, "utf8").slice(0, 2000);
        if (rawText.trim()) {
          const id = `${file.path}::file_chunk::raw`;
          const metadata: VectorMetadata = {
            id,
            filePath: file.path,
            nodeType: "file_chunk",
            nodeName: file.path,
            startLine: 1,
            endLine: 0,
          };
          const vector = await generateEmbedding(rawText);
          store.upsert(metadata, vector);
        }
      } catch {
        // Unreadable files are skipped
      }
    }

    indexed += 1;
    if (indexed % 10 === 0 || indexed === total) {
      options.onProgress?.(indexed, total);
      await store.save();
      // NOTE: Yield to the event loop so the chat UI handlers (keypress, etc.) can run
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await store.save();
  options.onDone?.(`RAG index complete: ${indexed} files processed.`);
  indexingActive = false;
}

/**
 * Checks whether a RAG index already exists for this workspace.
 */
export function hasRagIndex(workspacePath: string): boolean {
  return existsSync(path.join(workspacePath, ".rei", "rag-index.json"));
}

/**
 * Performs a semantic search over the indexed workspace.
 */
export async function searchRag(
  workspacePath: string,
  query: string,
  topK = 5,
): Promise<RagSearchResult[]> {
  const store = new VectorStore(workspacePath);
  await store.load();
  if (store.getRecordCount() === 0) return [];

  const queryVector = await generateEmbedding(query);
  return store.query(queryVector, topK) as RagSearchResult[];
}
