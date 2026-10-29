import * as fs from "node:fs";
import * as path from "node:path";
import { estimateTokens } from "../chat/helpers/token-estimator.js";

/**
 * A persona's knowledge base, whole, when it is small enough for the prompt (D3.5 of the public
 * channel plan). Searching it with the read tools costs a model call per round — most of a public
 * reply's 30–40 s — and a small model may skip the search and answer from memory. Inline, it is
 * always there, in one call, and as a stable prefix the backend can cache.
 */

/** Room for a sales or support knowledge base (~30 KB) in any window an agent model runs with. */
export const INLINE_KNOWLEDGE_MAX_TOKENS = 8000;

/** What reads as text. Anything else (a PDF, an image) only the read tools can reach. */
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json", ".yaml", ".yml"]);

export interface KnowledgeFile {
  /** Relative to the knowledge directory: the prompt never names the host's layout. */
  path: string;
  content: string;
}

/**
 * Every file of `dir`, or null when they do not all go in: one that is not text, or a total over
 * `maxTokens`. Partial knowledge inline would read as complete, so it is all or nothing.
 */
export function loadInlineKnowledge(dir: string, maxTokens = INLINE_KNOWLEDGE_MAX_TOKENS): KnowledgeFile[] | null {
  const files: KnowledgeFile[] = [];
  let tokens = 0;
  const walk = (abs: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // A link could point anywhere — out of the directory the channel confined reads to.
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!walk(full)) return false;
        continue;
      }
      if (!e.isFile()) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) return false;
      const content = fs.readFileSync(full, "utf8");
      tokens += estimateTokens(content);
      if (tokens > maxTokens) return false;
      files.push({ path: path.relative(dir, full).split(path.sep).join("/"), content });
    }
    return true;
  };
  if (!walk(dir) || files.length === 0) return null;
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
