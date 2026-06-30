import { VectorStore, VectorSearchResult } from "./vector-store.js";
import { generateEmbedding } from "./embedder.js";

interface MapNode {
  filePath: string;
  content: string;
  imports: string[];
  score: number;
}

/**
 * Extracts the // Imports: section from a map block.
 */
function extractImports(content: string): string[] {
  const importMatch = content.match(/\/\/ Imports: ([^\n\r]*)/);
  if (!importMatch) return [];
  return importMatch[1]
    .split(",")
    .map((i) => i.trim())
    .filter((i) => i && i !== "none");
}

/**
 * Retrieves the most relevant parts of the repository map using Multi-level Relevance.
 * Implements Semantic Base + Adjacency Boost + Hierarchical Injection.
 */
export async function getRelevantMapContext(
  vectorStore: VectorStore,
  query: string,
  topK: number = 5
): Promise<string> {
  if (!query) return "";

  const queryVector = await generateEmbedding(query, "query");
  // Fetch a wider pool to allow adjacency boosting to pull in dependencies
  const rawResults = vectorStore.query(queryVector, topK * 3);

  const mapNodes: MapNode[] = rawResults
    .filter((r) => r.metadata.nodeType === "repo_map_chunk")
    .map((r) => ({
      filePath: r.metadata.filePath,
      content: (r.metadata as any).content || "",
      imports: extractImports((r.metadata as any).content || ""),
      score: r.score,
    }));

  if (mapNodes.length === 0) return "";

  // --- 1. Adjacency Boost ---
  // If File A is highly relevant (>0.8), boost its imports
  const highRelevanceFiles = mapNodes.filter((n) => n.score > 0.8);
  const boostedFiles = new Set<string>();
  
  for (const node of highRelevanceFiles) {
    for (const imp of node.imports) {
      // Simple heuristic: match import string to filePath
      const target = mapNodes.find((n) => n.filePath.includes(imp));
      if (target) {
        target.score += 0.15;
        boostedFiles.add(target.filePath);
      }
    }
  }

  // Re-sort after boosting
  mapNodes.sort((a, b) => b.score - a.score);

  // --- 2. Hierarchical Assembly ---
  const finalContext: string[] = [];
  let fullCount = 0;
  let skeletonCount = 0;

  for (const node of mapNodes) {
    if (node.score > 0.85 && fullCount < 2) {
      // Level 'Full': Complete block
      finalContext.push(node.content);
      fullCount++;
    } else if (node.score > 0.6 && skeletonCount < 4) {
      // Level 'Skeleton': Only File and Imports
      const lines = node.content.split("\n");
      const fileLine = lines.find((l) => l.startsWith("// FILE:"));
      const importLine = lines.find((l) => l.startsWith("// Imports:"));
      
      if (fileLine) finalContext.push(fileLine);
      if (importLine) finalContext.push(importLine);
      finalContext.push(""); // Spacer
      skeletonCount++;
    }
  }

  return finalContext.join("\n\n");
}