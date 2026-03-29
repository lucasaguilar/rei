export interface KnowledgeChunk {
  source: string;
  title: string;
  url: string;
  content: string; // The summarized content
  relevanceScore: number;
  domain: string;
  provider: string; // e.g. "Angular Official Docs"
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchClient {
  search(query: string, allowedDomains: string[]): Promise<SearchResult[]>;
}

export interface SummarizeFunction {
  (query: string, rawText: string): Promise<string>;
}

export interface KnowledgeProvider {
  name: string;
  canHandle(query: string): boolean;
  search(
    query: string,
    searchClient: WebSearchClient,
    summarize: SummarizeFunction
  ): Promise<KnowledgeChunk[]>;
}
