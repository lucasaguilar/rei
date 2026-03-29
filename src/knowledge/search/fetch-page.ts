import * as https from "https";
import * as http from "http";

export async function fetchPageText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const module = isHttps ? https : http;

    const req = module.request(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Node.js/REI) RAG Crawler",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Handle single redirect
          const redirectUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          resolve(fetchPageText(redirectUrl));
          return;
        }

        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          // Extract text cleanly by removing scripts, styles, and tags
          let text = data;
          
          text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
          text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
          
          // Remove all remaining HTML tags
          text = text.replace(/<[^>]+>/g, " ");
          
          // Collapse whitespace and decode basic entities
          text = text
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/\s+/g, " ")
            .trim();

          resolve(text);
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });

    req.on("error", reject);
    req.end();
  });
}
