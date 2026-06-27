export interface DocChunk {
  id: string;
  /** 1-based page number, or 0 when the document has no page markers. */
  page: number;
  text: string;
}

export interface IndexedChunk extends DocChunk {
  vector: number[];
}

export interface DocIndex {
  /** Embedder that built this index (invalidate on change — vector spaces differ). */
  embedderId: string;
  /** Hash of the source file content (re-index when it changes). */
  fileHash: string;
  chunks: IndexedChunk[];
}

export type ClaimStatus = "verified" | "fuzzy" | "fabricated";

export interface Claim {
  text: string;
  page?: number;
  quote?: string;
  status: ClaimStatus;
}

export interface AskResult {
  answer: string;
  claims: Claim[];
  /** verified+fuzzy over total — how grounded the answer is. */
  faithfulness: { verified: number; total: number };
  /** True when the model said the answer isn't in the retrieved text. */
  notFound: boolean;
  /** Page numbers of the chunks that were retrieved and shown to the model. */
  sources: number[];
}
