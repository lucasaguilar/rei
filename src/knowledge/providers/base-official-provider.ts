import { KnowledgeChunk, KnowledgeProvider, SummarizeFunction, WebSearchClient } from "../types.js";
import { fetchPageText } from "../search/fetch-page.js";

export abstract class BaseOfficialProvider implements KnowledgeProvider {
  abstract name: string;
  protected abstract triggerKeywords: string[];
  protected abstract allowedDomains: string[];

  canHandle(query: string): boolean {
    const q = query.toLowerCase();
    // Also include exact keyword matches
    return this.triggerKeywords.some((kw) => {
      const regex = new RegExp(`\\b${kw.toLowerCase()}\\b`, "i");
      return regex.test(q) || q.includes(kw.toLowerCase());
    });
  }

  async search(
    query: string,
    searchClient: WebSearchClient,
    summarize: SummarizeFunction
  ): Promise<KnowledgeChunk[]> {
    const q = query.toLowerCase();
    const matchedKeywords = this.triggerKeywords.filter((kw) => {
      const regex = new RegExp(`\\b${kw.toLowerCase()}\\b`, "i");
      return regex.test(q) || q.includes(kw.toLowerCase());
    });
    
    // We only send the matched technical terms to the search engine.
    // Sending the user's full natural language sentence (especially in Spanish) guarantees 0 matches on DuckDuckGo.
    const optimizedQuery = matchedKeywords.slice(0, 3).join(" ");
    const results = await searchClient.search(optimizedQuery, this.allowedDomains);
    if (!results || results.length === 0) return [];

    // Focus on the absolute best result (top 2)
    const topResults = results.slice(0, 2);
    const chunks: KnowledgeChunk[] = [];

    for (let i = 0; i < topResults.length; i++) {
       const res = topResults[i];
       const domainMatched = this.allowedDomains.find(d => res.url.includes(d)) || "Official Docs";

       try {
         const rawPageText = await fetchPageText(res.url);
         const contextText = rawPageText.length > 500 ? rawPageText.substring(0, 8000) : res.snippet;
         
         const summary = await summarize(query, `Source Title: ${res.title}\nSource Snippet: ${res.snippet}\nPage Text: ${contextText}`);

         chunks.push({
           source: res.title,
           title: res.title,
           url: res.url,
           content: summary,
           relevanceScore: 100 - i * 10,
           domain: domainMatched,
           provider: this.name
         });
       } catch (error) {
         const summary = await summarize(query, `Source Title: ${res.title}\nSource Snippet: ${res.snippet}`);
         chunks.push({
           source: res.title,
           title: res.title,
           url: res.url,
           content: summary,
           relevanceScore: 50 - i * 10,
           domain: "Fallback Snippet",
           provider: this.name
         });
       }
    }

    return chunks;
  }
}
