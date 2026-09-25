import * as fs from "fs";
import * as path from "path";
import * as readline from "node:readline/promises";
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

    // Intent check: search only when the user explicitly asked to consult the web.
    const isExplicitRequest =
      /@(docs|web)\b/i.test(q) ||
      /busca(r)?\s+(en\s+)?(internet|la\s+web|online)/i.test(q) ||
      /investiga(r)?\s+(en\s+)?(internet|la\s+web|online)/i.test(q) ||
      /averigua(r)?\s+(en\s+)?(internet|la\s+web|online)/i.test(q) ||
      /search\s+(the\s+)?(web|internet|online|docs)/i.test(q) ||
      /\b(googlealo?|googlea)\b/i.test(q) ||
      /consulta(r)?\s+(la\s+)?(web|internet|documentaci[oó]n)/i.test(q) ||
      /look\s+(it\s+)?up\s+online/i.test(q);

    if (!isExplicitRequest) {
      return [];
    }

    // Optional: caching per session to avoid re-summarization
    if (this.cache.has(q)) {
      return this.cache.get(q)!;
    }

    const matchedProviders = this.providers.filter((p) => p.canHandle(query));

    if (matchedProviders.length === 0) {
      // Fallback: Búsqueda general con confirmación del usuario
      /*
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await rl.question(
        `\n[REI] No specific technical provider matched: "${query}".\nSearch the web generally? (y/n): `
      );
      rl.close();
      */

      //if (answer.toLowerCase() === 's') {
      const summarizer = createKnowledgeSummarizer(this.modelProvider, true);
      try {
        // Strip common lead-in phrases so the engine gets the actual search terms.
        let cleanQuery = query
          .replace(/@(docs|web)\b/gi, "")
          .replace(/busca(r)?\s+(en\s+)?(internet|la\s+web|online|google)?(\s+el|\s+la|\s+los|\s+las)?/gi, "")
          .replace(/investiga(r)?\s+(en\s+)?(internet|la\s+web|online)?(\s+el|\s+la|\s+los|\s+las)?/gi, "")
          .replace(/averigua(r)?\s+(en\s+)?(internet|la\s+web|online)?(\s+el|\s+la|\s+los|\s+las)?/gi, "")
          .replace(/search\s+(the\s+)?(web|internet|online|docs)?(\s+for)?/gi, "")
          .replace(/\b(googlealo?|googlea)\b(\s+el|\s+la|\s+los|\s+las)?/gi, "")
          .replace(/consulta(r)?\s+(la\s+)?(web|internet|documentaci[oó]n)?(\s+el|\s+la|\s+los|\s+las)?/gi, "")
          .replace(/look\s+(it\s+)?up\s+online/gi, "")
          .replace(/\s+/g, " ")
          .trim();

        if (!cleanQuery) {
          cleanQuery = query;
        }

        // An empty domain array switches DuckDuckGo to a general search.
        const results = await this.searchClient.search(cleanQuery, []);

        const combinedContent = results
          .map((r) => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
          .join("\n\n");

        // El resumidor espera (query, content)
        const summary = await summarizer(cleanQuery, combinedContent);

        const generalChunk: KnowledgeChunk = {
          content: summary,
          url: results[0]?.url || "web-search",
          title: results[0]?.title || "General Web Search",
          relevanceScore: 1,
          source: "web",
          domain: "general",
          provider: "DuckDuckGo",
        };

        this.cache.set(q, [generalChunk]);
        return [generalChunk];
      } catch (err) {
        console.error(`[REI] General search failed: ${err}`);
        return [];
      }
    }
    //return [];
    //}

    const allChunks: KnowledgeChunk[] = [];
    const summarizer = createKnowledgeSummarizer(this.modelProvider);

    // Limit to running max 2 providers if the query somehow overlaps both heavily
    for (const provider of matchedProviders.slice(0, 2)) {
      try {
        const chunks = await provider.search(
          query,
          this.searchClient,
          summarizer,
        );

        // Filter out useless chunks
        const validChunks = chunks.filter(
          (c) =>
            c.content &&
            !c.content.includes("No relevant technical implementation found"),
        );

        allChunks.push(...validChunks);
      } catch (err) {
        fs.appendFileSync(
          path.join(process.cwd(), ".rei-debug.log"),
          `[${new Date().toISOString()}] Provider ${provider.name} error: ${err}\n`,
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
