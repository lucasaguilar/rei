import { buildTurnContext } from "../src/context/context-builder.js";
import { searchRag } from "../src/context/rag/rag-indexer.js";
import { VectorStore } from "../src/context/rag/vector-store.js";
import { generateEmbedding } from "../src/context/rag/embedder.js";
import * as path from "path";

async function runDiagnostic() {
  const workspacePath = process.cwd();
  console.log("=== RAG DIAGNOSTIC TOOL ===");

  // 1. Check Vector Store Stats
  const store = new VectorStore(workspacePath);
  await store.load();
  console.log(
    `\n📊 Vector Store: Loaded ${store.getRecordCount()} total chunks.`,
  );

  // 2. Test RAG Search Ranking
  const testQuery =
    "quisiera verificar porque no se ven los iconos que pusimos al label de model que me muestra en cada respuesta de REI";
  console.log(`\n🔍 Searching RAG for: "${testQuery}"`);
  const ragResults = await searchRag(workspacePath, testQuery, 15);

  console.log(`\n🏆 Top 15 RAG Hits:`);
  ragResults.forEach((hit, i) => {
    console.log(
      `\n  [${i + 1}] Score: ${(hit.score * 100).toFixed(1)}% | ${hit.metadata.nodeType} -> ${hit.metadata.nodeName} (${hit.metadata.filePath})`,
    );
  });

  // 3. Test Full Context Builder (Simulating a Turn)
  console.log(`\n🧠 Simulating Full Context Builder for Turn...`);
  const context = await buildTurnContext({
    workspacePath,
    userInput: testQuery,
    mode: "planning",
  });

  console.log(`\n📄 Selected Files for Context Injection:`);
  context.relevantFiles.forEach((f) => {
    console.log(
      `  - ${f.path} (Score: ${f.score}) | Bytes injected: ${f.preview.length}`,
    );
  });

  if (context.ragNodeSnippets && context.ragNodeSnippets.length > 0) {
    console.log(`\n✂️ Deep AST Snippets extracted by RAG:`);
    context.ragNodeSnippets.forEach((s) => {
      console.log(
        `  - ${s.nodeName} (${s.filePath}) | Lines: ${s.startLine}-${s.endLine}`,
      );
    });
  }
}

runDiagnostic().catch(console.error);
