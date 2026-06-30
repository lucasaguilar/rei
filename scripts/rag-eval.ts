import { buildTurnContext } from "../src/context/context-builder.js";
import {
  searchRag,
  startIndexingWorker,
} from "../src/context/rag/rag-indexer.js";
import { VectorStore } from "../src/context/rag/vector-store.js";
import { generateEmbedding } from "../src/context/rag/embedder.js";
import * as path from "path";

async function runDiagnostic() {
  const workspacePath = process.cwd();
  console.log("=== RAG DIAGNOSTIC TOOL ===");

  // 0. Rebuild RAG index
  console.log("⏳ Rebuilding RAG index with the new AST parser...");
  await new Promise<void>((resolve) => {
    startIndexingWorker(workspacePath, {
      onDone: (msg) => {
        console.log(`\n✅ ${msg}`);
        resolve();
      },
      onProgress: (i, t) => {
        process.stdout.write(`\rProgress: ${i}/${t} files...`);
      },
    });
  });

  // 1. Check Vector Store Stats
  const store = new VectorStore(workspacePath);
  await store.load();
  console.log(
    `\n📊 Vector Store: Loaded ${store.getRecordCount()} total chunks.`,
  );

  // 2. Test RAG Search Ranking
  const testQueryEs = "dónde armo el contexto";
  const testQueryEn = "where do i assemble the context";

  console.log(`\n🔍 Searching RAG (Spanish) for: "${testQueryEs}"`);
  const ragResultsEs = await searchRag(workspacePath, testQueryEs, 10);
  console.log(`\n🏆 Top 10 RAG Hits (Spanish):`);
  ragResultsEs.forEach((hit, i) => {
    console.log(
      `  [${i + 1}] Score: ${(hit.score * 100).toFixed(1)}% | ${hit.metadata.nodeType} -> ${hit.metadata.nodeName} (${hit.metadata.filePath})`,
    );
  });

  console.log(`\n🔍 Searching RAG (English) for: "${testQueryEn}"`);
  const ragResultsEn = await searchRag(workspacePath, testQueryEn, 10);
  console.log(`\n🏆 Top 10 RAG Hits (English):`);
  ragResultsEn.forEach((hit, i) => {
    console.log(
      `  [${i + 1}] Score: ${(hit.score * 100).toFixed(1)}% | ${hit.metadata.nodeType} -> ${hit.metadata.nodeName} (${hit.metadata.filePath})`,
    );
  });

  // 3. Test Full Context Builder (Simulating a Turn)
  console.log(`\n🧠 Simulating Full Context Builder for Turn...`);
  const context = await buildTurnContext({
    workspacePath,
    userInput: testQueryEs,
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
