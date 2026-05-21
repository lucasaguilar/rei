import * as https from "https";
import * as fs from "fs";
import { SearchResult, WebSearchClient } from "../types.js";

/**
 * A zero-dependency DuckDuckGo Lite HTML scraper.
 * This is fragile but works out-of-the-box without API keys.
 */
export class DuckDuckGoLiteClient implements WebSearchClient {
  async search(
    query: string,
    allowedDomains: string[],
  ): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    if (allowedDomains.length === 0) {
      const html = await this.fetchHtml(query);
      return this.parseResults(html);
    }

    // DuckDuckGo Lite often fails complex 'OR' queries between sites.
    // It is significantly more reliable to run a separate query for each allowed domain concurrently.
    const searchPromises = allowedDomains.map(async (domain) => {
      try {
        const finalQuery = `${query} site:${domain}`.trim();
        const html = await this.fetchHtml(finalQuery);
        return this.parseResults(html);
      } catch (e) {
        return [];
      }
    });

    const nestedResults = await Promise.all(searchPromises);
    const allResults = nestedResults.flat();

    // De-duplicate just in case
    const seenUrls = new Set<string>();
    return allResults.filter((r) => {
      if (seenUrls.has(r.url)) return false;
      seenUrls.add(r.url);
      return true;
    });
  }

  private fetchHtml(query: string): Promise<string> {
    const postData = new URLSearchParams({ q: query }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "lite.duckduckgo.com",
          path: "/lite/",
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(postData),
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            Origin: "https://lite.duckduckgo.com",
            Referer: "https://lite.duckduckgo.com/",
          },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            reject(
              new Error(`DDG strict redirect detected (${res.statusCode})`),
            );
            return;
          }

          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", () => {
            resolve(data);
          });
        },
      );

      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  private parseResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const docSplit = html.split("<tr");

    let currentTitle = "";
    let currentUrl = "";

    for (const chunk of docSplit) {
      // Ignorar publicidad patrocinada (ruido)
      if (chunk.includes("result-sponsored")) {
        continue;
      }

      // Extraer URL, clase y título de forma flexible y tolerante a comillas
      const hrefMatch = chunk.match(/href=['"]([^'"]+)['"]/i);
      const classMatch = chunk.match(/class=['"]result-(url|link)['"]/i);
      const titleMatch = chunk.match(/<a[^>]*>([\s\S]*?)<\/a>/i);

      if (hrefMatch && classMatch && titleMatch) {
        currentUrl = hrefMatch[1];
        currentTitle = titleMatch[1];
        continue; // Esperar al snippet en el siguiente <tr>
      }

      // Extraer snippet de forma flexible y tolerante a comillas
      const snippetMatch = chunk.match(
        /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i,
      );
      if (snippetMatch && currentUrl) {
        let rawSnippet = snippetMatch[1];
        // Clean tags and HTML entities
        rawSnippet = rawSnippet
          .replace(/<[^>]+>/g, "")
          .replace(/&[^;]+;/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        // DuckDuckGo redirects often look like /lite/...
        // We decode the real URL from the query parameter if it's a redirect.
        let realUrl = currentUrl;
        if (
          realUrl.startsWith("//duckduckgo.com/l/?") ||
          realUrl.startsWith("/l/?")
        ) {
          const match = realUrl.match(/[?&]uddg=([^&]+)/);
          if (match) {
            realUrl = decodeURIComponent(match[1]);
          }
        }

        results.push({
          title: currentTitle.replace(/<[^>]+>/g, "").trim(),
          url: realUrl,
          snippet: rawSnippet,
        });

        currentTitle = "";
        currentUrl = "";
      }
    }

    // Fallback if the structure changed: try to extract just standard <a> links
    // to allowed domains if the page looks broken.
    if (results.length === 0) {
      const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = anchorRegex.exec(html)) !== null) {
        let realUrl = match[1];
        if (
          realUrl.startsWith("//duckduckgo.com") ||
          realUrl.startsWith("/l/?")
        ) {
          const uMatch = realUrl.match(/[?&]uddg=([^&]+)/);
          if (uMatch) realUrl = decodeURIComponent(uMatch[1]);
        }

        const titleText = match[2].replace(/<[^>]+>/g, "").trim();
        if (realUrl.startsWith("http") && !realUrl.includes("duckduckgo.com")) {
          results.push({
            title: titleText || "External Link",
            url: realUrl,
            snippet: "Content retrieved via fallback HTML parsing.",
          });
        }
      }
    }

    return results;
  }
}
