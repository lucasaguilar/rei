import { generateEmbedding } from "../../context/rag/embedder.js";
import type { DocIndex, IndexedChunk } from "./types.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface RetrievedChunk extends IndexedChunk {
  score: number;
}

/** Embeds the query with the SAME embedder that built the index, returns the top-k chunks. */
export async function retrieve(
  index: DocIndex,
  query: string,
  k = 6,
): Promise<RetrievedChunk[]> {
  if (index.chunks.length === 0) return [];
  const queryVector = await generateEmbedding(query, "query");
  return index.chunks
    .map((c) => ({ ...c, score: cosine(queryVector, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Exported for unit testing the ranking without a live embedder.
export const __cosine = cosine;
