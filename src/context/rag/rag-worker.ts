import { parentPort, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";
import {
  supportsAstIndexingExtension,
  getLanguageCapabilityForExtension,
} from "../../language/language-capabilities.js";
import { AstProviderFactory } from "../ast-providers/ast-provider-factory.js";
import type { SourceFileLike, AstChunk } from "../ast-providers/ast-provider.js";
import { HeuristicAstProvider } from "../ast-providers/heuristic-ast-provider.js";
import { VectorStore, type VectorMetadata } from "./vector-store.js";
import { generateEmbedding } from "./embedder.js";

async function runWorker(): Promise<void> {
  const { workspacePath } = (workerData ?? {}) as { workspacePath: string };
  if (!workspacePath) {
    parentPort?.postMessage({ type: "error", error: "Missing workspacePath" });
    return;
  }

  const files = scanWorkspace(workspacePath);
  if (files.length === 0) {
    parentPort?.postMessage({
      type: "done",
      message: "RAG: No files found to index.",
      indexed: 0,
      total: 0,
    });
    return;
  }

  const store = new VectorStore(workspacePath);
  await store.load();

  // Smart Garbage Collection: Clean up deleted files from store
  const activePaths = new Set(files.map((f) => f.path));
  await store.cleanupStaleFiles(activePaths);

  let indexed = 0;
  const total = files.length;

  // Send initial 0 progress
  parentPort?.postMessage({ type: "progress", indexed: 0, total });

  for (const file of files) {
    const absPath = path.resolve(workspacePath, file.path);

    if (supportsAstIndexingExtension(file.extension)) {
      let content: string | undefined;
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        // Skip unreadable file
      }

      if (content !== undefined) {
        const languageId = getLanguageCapabilityForExtension(file.extension).id;
        const fileLike: SourceFileLike = {
          filePath: file.path,
          absoluteFilePath: absPath,
          languageId,
          content,
        };

        let astChunks: AstChunk[] = [];
        try {
          const provider = AstProviderFactory.resolve(fileLike);
          astChunks = await provider.extractChunks(fileLike);
        } catch {
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
        // Skip unreadable file
      }
    }

    indexed += 1;
    // Send progress updates back to main CLI thread on EVERY file
    parentPort?.postMessage({ type: "progress", indexed, total });
  }

  await store.save();
  parentPort?.postMessage({
    type: "done",
    message: `RAG index complete: ${indexed} files processed.`,
    indexed,
    total,
  });
}

runWorker().catch((err) => {
  parentPort?.postMessage({
    type: "error",
    error: err instanceof Error ? err.message : String(err),
  });
});
