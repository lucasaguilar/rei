import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { generateEmbedding, getEmbedderId } from "../../context/rag/embedder.js";
import { chunkDocument } from "./chunker.js";
import type { DocIndex } from "./types.js";

/** Where a document's vector index is cached. Hidden (.rei) — it's internal, never @-referenced. */
function indexPath(filePath: string, workspacePath: string): string {
  const base = path.basename(filePath).replace(/[^\w.-]/g, "_");
  return path.join(workspacePath, ".rei", "ocr", `${base}.index.json`);
}

function hashText(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * Builds (or loads from cache) the vector index for a document. The cache is invalidated when
 * the file content changes OR the embedder changes (both fold into the stored {fileHash,
 * embedderId}). Embedding happens chunk-by-chunk via the configured embedder.
 */
export async function indexDocument(
  filePath: string,
  workspacePath: string,
  onStatus?: (message: string) => void,
): Promise<DocIndex> {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const fileHash = hashText(raw);
  const embedderId = getEmbedderId();
  const cachePath = indexPath(filePath, workspacePath);

  // Reuse the cache when both the content and the embedder are unchanged.
  try {
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(await fs.promises.readFile(cachePath, "utf-8")) as DocIndex;
      if (cached.fileHash === fileHash && cached.embedderId === embedderId) {
        return cached;
      }
    }
  } catch {
    /* fall through to rebuild */
  }

  const chunks = chunkDocument(raw);
  onStatus?.(`📚 Indexing ${path.basename(filePath)} — ${chunks.length} chunks (${embedderId})…`);

  const indexed: DocIndex["chunks"] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i % 10 === 0 && i > 0) onStatus?.(`   …embedded ${i}/${chunks.length} chunks`);
    const vector = await generateEmbedding(chunks[i].text);
    indexed.push({ ...chunks[i], vector });
  }
  onStatus?.(`   …embedded ${chunks.length}/${chunks.length} chunks ✓`);

  const index: DocIndex = { embedderId, fileHash, chunks: indexed };
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(cachePath, JSON.stringify(index), "utf-8");
  } catch {
    /* non-fatal: just don't cache */
  }
  return index;
}
