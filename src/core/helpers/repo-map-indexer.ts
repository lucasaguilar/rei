import * as crypto from "node:crypto";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  generateRepoMap,
  generateRepoMapForFile,
} from "../../tools/repo-map-generator.js";
import { VectorStore } from "../../context/rag/vector-store.js";
import { generateEmbedding } from "../../context/rag/embedder.js";
import {
  chunkRepoMap,
  chunkRepoMapString,
} from "../../context/rag/map-chunker.js";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";
import { getWatcherGlobs } from "../../language/language-capabilities.js";
import type { AgentLogger } from "../logger.js";

/**
 * Ensures the repository skeleton map is generated, cleaned, chunked, and fully indexed in VectorStore.
 * Returns the generated repo map string.
 */
export async function ensureRepoMapIndexed(params: {
  workspacePath: string;
  vectorStore: VectorStore;
  logger: AgentLogger;
  onStatus?: (status: "indexing_repository") => void;
}): Promise<string> {
  const { workspacePath, vectorStore, logger, onStatus } = params;

  const repoMap = await generateRepoMap(workspacePath);
  await vectorStore.load();

  // Clear ghost entries (files deleted while REI was shut down)
  const currentFiles = scanWorkspace(workspacePath);
  const activePaths = new Set(currentFiles.map((f) => f.path));
  await vectorStore.cleanupStaleFiles(activePaths);

  const chunks = await chunkRepoMap(workspacePath);
  const chunksToEmbed = chunks.filter((chunk) => {
    const hash = crypto
      .createHash("md5")
      .update(chunk.content)
      .digest("hex");
    const existing = vectorStore.getById(chunk.metadata.id);
    return !existing || existing.metadata.fileHash !== hash;
  });

  if (chunksToEmbed.length > 0) {
    onStatus?.("indexing_repository");
  }

  for (const chunk of chunks) {
    const hash = crypto
      .createHash("md5")
      .update(chunk.content)
      .digest("hex");
    const existing = vectorStore.getById(chunk.metadata.id);

    if (existing && existing.metadata.fileHash === hash) {
      continue; // Skip embed calculation if content has not changed
    }

    const vector = await generateEmbedding(chunk.content);
    vectorStore.upsert(
      {
        ...chunk.metadata,
        content: chunk.content,
        fileHash: hash,
      },
      vector,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  await vectorStore.save();
  return repoMap;
}

/**
 * Initializes the chokidar FS watcher for real-time AST and VectorStore updates.
 */
export function initWatcher(params: {
  workspacePath: string;
  vectorStore: VectorStore;
  logger: AgentLogger;
  clearScanCache: () => void;
}): FSWatcher {
  const { workspacePath, vectorStore, logger, clearScanCache } = params;

  logger.logInfo("Initializing file watcher for incremental AST updates");
  const watcher = chokidar.watch(
    getWatcherGlobs(),
    {
      cwd: workspacePath,
      ignored: [
        "**/node_modules/**",
        "**/dist/**",
        ".rei/**",
        "**/.rei/**",
        "**/.git/**",
        "**/bin/**",
        "**/obj/**",
      ],
      persistent: true,
      ignoreInitial: true,
    },
  );

  const handleChange = async (filePath: string) => {
    clearScanCache();
    const absPath = path.join(workspacePath, filePath);
    const relFilePath = filePath.replace(/\\/g, "/");

    vectorStore.deleteByFilePath(relFilePath);

    const newMapString = await generateRepoMapForFile(workspacePath, absPath);
    if (newMapString) {
      const chunks = chunkRepoMapString(newMapString);
      for (const chunk of chunks) {
        const hash = crypto
          .createHash("md5")
          .update(chunk.content)
          .digest("hex");
        const existing = vectorStore.getById(chunk.metadata.id);
        if (existing && existing.metadata.fileHash === hash) continue;

        const vector = await generateEmbedding(chunk.content);
        vectorStore.upsert(
          {
            ...chunk.metadata,
            content: chunk.content,
            fileHash: hash,
          },
          vector,
        );
      }
    }

    await vectorStore.save();
  };

  const handleUnlink = async (filePath: string) => {
    clearScanCache();
    const relFilePath = filePath.replace(/\\/g, "/");
    vectorStore.deleteByFilePath(relFilePath);
    await vectorStore.save();
  };

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);
  watcher.on("unlink", handleUnlink);

  return watcher;
}
