/**
 * Tool selection for the agent tools path — keeps the function-calling `tools`
 * array small when many MCP servers are connected (a full Google Workspace server
 * adds ~60-90 tools / ~15-30k tokens, which overflows local context).
 *
 * Strategy (model-driven, no embeddings):
 *  - Expose built-in agent tools + a lightweight `search_tools` meta-tool + a small
 *    best-effort pre-load of likely-relevant MCP tools.
 *  - The model calls `search_tools("gmail email")` to load more on demand. The model
 *    understands intent (incl. cross-lingual: "correos" → gmail) far better than a
 *    small local embedder, so a simple lexical keyword search over tool names +
 *    descriptions is enough — and avoids embedding 150 tools every connect.
 */
import type { McpTool } from "./mcp/mcp-client.js";
import type { ToolDefinition } from "../providers/model-provider.js";

/** Below this many MCP tools, the array is small enough — expose them all directly. */
export const MAX_UNFILTERED = 25;
/** Best-effort tools pre-loaded into the array before the model searches. */
export const PRELOAD_K = 8;
/** Tools returned per `search_tools` call. */
export const SEARCH_K = 10;
/** Cap per MCP server so one big server (e.g. Spotify) can't crowd out the rest. */
const MAX_PER_SERVER = 6;

/**
 * Bilingual intent → service keywords, so a query like "correos" lexically lifts
 * Gmail tools even when the user's wording doesn't contain the English service name.
 */
const INTENT_KEYWORDS: Array<{ triggers: RegExp; services: string[] }> = [
  { triggers: /\b(correo|correos|email|emails|mail|gmail|mensaje|bandeja|inbox)\b/i, services: ["gmail", "mail", "message"] },
  { triggers: /\b(m[uú]sica|canci[oó]n|tema|spotify|playlist|reproduc|escuch|álbum|album|artista)\b/i, services: ["spotify"] },
  { triggers: /\b(archivo|archivos|documento|carpeta|drive|file|folder)\b/i, services: ["drive", "doc", "file"] },
  { triggers: /\b(calendario|evento|eventos|agenda|reuni[oó]n|calendar|meeting)\b/i, services: ["calendar", "event"] },
  { triggers: /\b(hoja|planilla|spreadsheet|sheet|excel)\b/i, services: ["sheet", "spreadsheet"] },
  { triggers: /\b(contacto|contactos|contact)\b/i, services: ["contact"] },
  { triggers: /\b(chat|espacio|space)\b/i, services: ["chat", "space"] },
];

function intentServices(query: string): string[] {
  const set = new Set<string>();
  for (const { triggers, services } of INTENT_KEYWORDS) {
    if (triggers.test(query)) services.forEach((s) => set.add(s));
  }
  return [...set];
}

function serverOf(name: string): string {
  const i = name.indexOf("/");
  return i === -1 ? name : name.slice(0, i);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Lexically scores `tools` against `query` (token overlap + bilingual intent boost)
 * and returns the top `limit`, capped per server so one big server can't dominate.
 */
export function searchMcpTools(query: string, tools: McpTool[], limit: number): McpTool[] {
  if (tools.length === 0) return [];
  const qTokens = new Set(tokenize(query));
  const services = intentServices(query);

  const scored = tools
    .map((t) => {
      const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
      const tTokens = tokenize(hay);
      let overlap = 0;
      for (const tok of tTokens) if (qTokens.has(tok)) overlap++;
      // Intent boost dominates token overlap so the right service surfaces first.
      const intentBoost = services.some((s) => hay.includes(s)) ? 10 : 0;
      return { tool: t, score: intentBoost + overlap };
    })
    .sort((a, b) => b.score - a.score);

  const perServer = new Map<string, number>();
  const out: McpTool[] = [];
  for (const { tool } of scored) {
    if (out.length >= limit) break;
    const srv = serverOf(tool.name);
    const count = perServer.get(srv) ?? 0;
    if (count >= MAX_PER_SERVER) continue;
    perServer.set(srv, count + 1);
    out.push(tool);
  }
  return out;
}

/**
 * The `search_tools` meta-tool definition exposed to the model when there are too
 * many MCP tools to send all upfront. Mirrors how capable agents do on-demand tool
 * discovery (e.g. Claude Code's ToolSearch).
 */
export const SEARCH_TOOLS_DEF: ToolDefinition = {
  type: "function",
  function: {
    name: "search_tools",
    description:
      "Search for additional MCP tools to use (e.g. for email, calendar, files, music). " +
      "Many tools are not loaded upfront to save context. Call this with keywords describing " +
      "what you want to do (e.g. \"gmail read emails\", \"create calendar event\") to load the " +
      "matching tools — they become callable right after. Always search BEFORE concluding a tool " +
      "is unavailable.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords describing the capability you need (English works best, e.g. 'gmail search messages').",
        },
      },
      required: ["query"],
    },
  },
};
