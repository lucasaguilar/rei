import { VectorStore } from "../src/context/rag/vector-store.js";
import { generateEmbedding } from "../src/context/rag/embedder.js";
import * as path from "path";

async function main() {
  const workspacePath = process.cwd();
  const store = new VectorStore(workspacePath);
  await store.load();

  console.log("=== RAG TARGETED DIAGNOSTIC ===");

  const query = "quisiera verificar porque no se ven los iconos que pusimos al label de model que me muestra en cada respuesta de REI";
  console.log(`Query: "${query}"\n`);

  const queryVector = await generateEmbedding(query);

  // Retrieve all records from the store
  const allRecords = store.query(queryVector, 9999);

  // Filter records belonging to input-turn.helpers.ts
  const targetRecords = allRecords.filter(
    (record) => record.metadata.filePath.includes("input-turn.helpers.ts")
  );

  console.log(`Found ${targetRecords.length} chunks for 'input-turn.helpers.ts':`);
  targetRecords.forEach((record, index) => {
    console.log(`\n[Chunk ${index + 1}]`);
    console.log(`Type: ${record.metadata.nodeType} | Name: ${record.metadata.nodeName} | Lines: ${record.metadata.startLine}-${record.metadata.endLine}`);
    console.log(`Similarity Score: ${(record.score * 100).toFixed(2)}%`);
  });
}

main().catch(console.error);
