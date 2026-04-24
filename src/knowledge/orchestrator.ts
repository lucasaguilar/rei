import * as fs from "fs";
import * as path from "path";
import { KnowledgeChunk, KnowledgeProvider, WebSearchClient } from "./types.js";
import { AngularOfficialProvider } from "./providers/angular-official.js";
import { IonicOfficialProvider } from "./providers/ionic-official.js";
import { SpringOfficialProvider } from "./providers/spring-official.js";
import { TypeScriptOfficialProvider } from "./providers/typescript-official.js";
import { NodeOfficialProvider } from "./providers/node-official.js";
import { DuckDuckGoLiteClient } from "./search/ddg-search-client.js";
import { createKnowledgeSummarizer } from "./summarizer/summarize-knowledge.js";
import { ModelProvider } from "../providers/model-provider.js";

export class KnowledgeOrchestrator {
  private providers: KnowledgeProvider[] = [
    new AngularOfficialProvider(),
    new IonicOfficialProvider(),
    new SpringOfficialProvider(),
    new TypeScriptOfficialProvider(),
    new NodeOfficialProvider(),
  ];

  private searchClient: WebSearchClient = new DuckDuckGoLiteClient();
  private cache = new Map<string, KnowledgeChunk[]>();

  constructor(private modelProvider: ModelProvider) {}

  /**
   * Evaluates the query against all registered providers.
   * If a domain matches, it queries the web docs, summarizes them, 
   * and returns the knowledge chunks to inject into the LLM context.
   */
  async getExternalKnowledge(query: string): Promise<KnowledgeChunk[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    // Validar intención: Solo buscar si el usuario pide explícitamente consultar documentación, 
    // buscar en la web, o si está haciendo una pregunta técnica directa ("cómo...?", "how to...").
    const isExplicitRequest = /@docs|@web|documentaci[oó]n|buscar?|busca/i.test(q);
    const isQuestion = (q.includes("como ") || q.includes("cómo ") || q.includes("how to ")) && q.includes("?");
    
    if (!isExplicitRequest && !isQuestion) {
      return [];
    }

    // Optional: caching per session to avoid re-summarization
    if (this.cache.has(q)) {
      return this.cache.get(q)!;
    }

    const matchedProviders = this.providers.filter((p) => p.canHandle(query));
    if (matchedProviders.length === 0) {
      return [];
    }

    const allChunks: KnowledgeChunk[] = [];
    const summarizer = createKnowledgeSummarizer(this.modelProvider);

    // Limit to running max 2 providers if the query somehow overlaps both heavily
    for (const provider of matchedProviders.slice(0, 2)) {
      try {
        const chunks = await provider.search(query, this.searchClient, summarizer);
        
        // Filter out useless chunks
        const validChunks = chunks.filter(c => 
           c.content && 
           !c.content.includes("No relevant technical implementation found")
        );

        allChunks.push(...validChunks);
      } catch (err) {
        fs.appendFileSync(
          path.join(process.cwd(), ".rei-debug.log"),
          `[${new Date().toISOString()}] Provider ${provider.name} error: ${err}\n`
        );
      }
    }

    // Sort heavily by score, ensuring best snippet first
    allChunks.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    // Take the absolute best 3 chunks maximum across providers
    const topContext = allChunks.slice(0, 3);
    
    // Cache the result to avoid spamming searches
    this.cache.set(q, topContext);

    return topContext;
  }
}
