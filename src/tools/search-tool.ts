import { DuckDuckGoLiteClient } from "../knowledge/search/ddg-search-client.js";
import { createKnowledgeSummarizer } from "../knowledge/summarizer/summarize-knowledge.js";
import { ModelProvider } from "../providers/model-provider.js";

/**
 * Searches the web using DuckDuckGo Lite and summarizes the results for LLM ingestion.
 *
 * @param query The search query.
 * @param provider The LLM model provider to run the summarization.
 */
export async function searchWeb(query: string, provider: ModelProvider): Promise<string> {
  const searchClient = new DuckDuckGoLiteClient();
  const summarizer = createKnowledgeSummarizer(provider, true);

  // Limpiar frases introductorias comunes de búsqueda para obtener mejores términos en el motor
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

  try {
    const results = await searchClient.search(cleanQuery, []);
    if (results.length === 0) {
      return "No search results found.";
    }

    const combinedContent = results
      .map((r) => `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
      .join("\n\n");

    const summary = await summarizer(cleanQuery, combinedContent);
    return summary;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Error searching web for "${query}": ${msg}`);
  }
}
