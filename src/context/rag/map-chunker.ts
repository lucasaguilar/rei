import fs from "node:fs/promises";
import path from "node:path";
import { VectorMetadata } from "./vector-store.js";

export interface RepoMapChunk {
  content: string;
  metadata: VectorMetadata;
}

/**
 * Parses the generated repo-skeleton-map.txt into individual chunks.
 * Each chunk represents one file's declarations.
 */
export async function chunkRepoMap(workspacePath: string): Promise<RepoMapChunk[]> {
  const mapPath = path.join(workspacePath, ".rei/logs/repo-skeleton-map.txt");
  
  try {
    const content = await fs.readFile(mapPath, "utf8");
    
    // Split by the "// FILE: " marker, but keep the marker in the result
    const fileBlocks = content.split(/(?= \/\/ FILE: )|(?=^\/\/ FILE: )/m);
    
    const chunks: RepoMapChunk[] = [];

    for (const block of fileBlocks) {
      const trimmedBlock = block.trim();
      if (!trimmedBlock || trimmedBlock.startsWith("### REPOSITORY SKELETON MAP")) continue;

      // Extract file path from "// FILE: path/to/file"
      const fileMatch = trimmedBlock.match(/^\/\/ FILE: ([^\s\n]+)/);
      if (!fileMatch) continue;

      const filePath = fileMatch[1];

      // Extract dependencies from "// Imports: file1, file2"
      const importMatch = trimmedBlock.match(/\/\/ Imports: ([^\n\r]*)/);
      const dependencies = importMatch 
        ? importMatch[1].split(",").map(i => i.trim()).filter(i => i && i !== "none")
        : [];
      
      chunks.push({
        content: trimmedBlock,
        metadata: {
          id: `map:${filePath}`,
          filePath: filePath,
          nodeType: "repo_map_chunk",
          nodeName: "file_summary",
          startLine: 0,
          endLine: 0,
          content: trimmedBlock,
          dependencies: dependencies,
        } as VectorMetadata,
      });
    }

    return chunks;
  } catch (err) {
    console.error(`[MapChunker] Error reading repo map: ${err}`);
    return [];
  }
}