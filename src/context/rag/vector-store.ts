import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export interface VectorMetadata {
  id: string; // identifcador único (ej. filePath + nodeName)
  filePath: string; // Ruta relativa dentro del workspace
  nodeType: string; // 'function', 'class', 'interface', 'file_chunk'
  nodeName: string; // Nombre de la clase o función
  startLine: number;
  endLine: number;
  fileHash?: string; // Para evitar rediseñar nodos no modificados (futuro)
}

export interface VectorRecord {
  vector: number[];
  metadata: VectorMetadata;
}

export interface VectorSearchResult {
  score: number;
  metadata: VectorMetadata;
}

/**
 * Base de Datos Vectorial Nativa y Aislada.
 * Utiliza JSON flat files, lo cual es inmensamente rápido en Node.js (V8)
 * para repositorios con <10.000 nodos (Vectores flotantes).
 */
export class VectorStore {
  private records: VectorRecord[] = [];
  private storePath: string;

  constructor(workspacePath: string) {
    // Aislamiento: El índice semántico vive SOLO dentro de <workspace>/.rei/
    const reiDir = path.join(workspacePath, ".rei");
    this.storePath = path.join(reiDir, "rag-index.json");
    if (!existsSync(reiDir)) {
      import("node:fs").then((f) => f.mkdirSync(reiDir, { recursive: true }));
    }
  }

  /**
   * Carga los embeddings cacheados en memoria.
   */
  async load(): Promise<void> {
    try {
      if (existsSync(this.storePath)) {
        const data = await fs.readFile(this.storePath, "utf8");
        this.records = JSON.parse(data);
      }
    } catch (err) {
      console.warn(`[RAG] Error loading vector store from ${this.storePath}`);
    }
  }

  /**
   * Persiste la base vectorial a disco de forma atómica.
   */
  async save(): Promise<void> {
    try {
      // Escribir en un temp y luego renombrar previene corrupción
      const tmpPath = `${this.storePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.records), "utf8");
      await fs.rename(tmpPath, this.storePath);
    } catch (err) {
      console.error(
        `[RAG] Error saving vector store to ${this.storePath}`,
        err,
      );
    }
  }

  /**
   * Inserta o actualiza un embedding para un nodo semántico del workspace.
   */
  upsert(metadata: VectorMetadata, vector: number[]): void {
    const existingIndex = this.records.findIndex(
      (r) => r.metadata.id === metadata.id,
    );
    if (existingIndex >= 0) {
      this.records[existingIndex] = { vector, metadata };
    } else {
      this.records.push({ vector, metadata });
    }
  }

  /**
   * Busca los topK fragmentos semánticamente más similares al Query Vector.
   */
  query(queryVector: number[], topK: number = 5): VectorSearchResult[] {
    const results = this.records.map((r) => ({
      metadata: r.metadata,
      score: this.cosineSimilarity(queryVector, r.vector),
    }));

    // Ordenar de mayor (1.0) a menor similitud
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }

  /**
   * Similitud de Coseno Rápida (Producto Punto sobre Magnitudes).
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getRecordCount(): number {
    return this.records.length;
  }
}
