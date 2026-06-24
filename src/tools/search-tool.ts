import { DuckDuckGoLiteClient } from "../knowledge/search/ddg-search-client.js";
import { createKnowledgeSummarizer } from "../knowledge/summarizer/summarize-knowledge.js";
import { ModelProvider } from "../providers/model-provider.js";

/**
 * Builds a verbatim, numbered "Sources" list from raw search results so the agent always
 * has the REAL URLs to cite. The summarizer condenses results into prose and can drop the
 * links, which makes models fabricate plausible-but-fake URLs when asked for "links to dig
 * deeper" — appending the untouched sources guarantees real links regardless of the summary.
 * Dedupes by URL and skips entries without one. Returns "" when there are no usable URLs.
 */
export function formatSourcesList(
  results: Array<{ title?: string; url?: string }>,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of results) {
    const url = r.url?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = r.title?.trim() || url;
    lines.push(`${lines.length + 1}. ${title} — ${url}`);
  }
  return lines.length
    ? `Sources (verbatim — cite these exact URLs; do NOT invent or alter links):\n${lines.join("\n")}`
    : "";
}

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

    // Append the real source URLs verbatim — the summarizer can drop them, and without
    // them the model invents links when asked to provide sources.
    const sources = formatSourcesList(results);
    return sources ? `${summary}\n\n${sources}` : summary;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Error searching web for "${query}": ${msg}`);
  }
}
