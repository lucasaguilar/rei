import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Resolve the prompts directory relative to this file's location.
// src/prompts/loader.ts -> ../../prompts (up to src, up to root, into prompts/).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_ROOT = path.resolve(__dirname, "../../prompts");
// REI project root (one level above prompts/)
const REI_ROOT = path.resolve(PROMPTS_ROOT, "..");

// In-memory cache: section key -> trimmed file contents.
const cache = new Map<string, string>();

/**
 * Loads a prompt section from a Markdown file on disk and returns its
 * trimmed contents. Results are cached in memory for the lifetime of the
 * process so repeated calls within a session are free.
 *
 * @param section - Path relative to the `/prompts` root, without the `.md`
 *   extension. Examples: `"shared/base"`, `"modes/ask"`, `"formats/agent-format"`.
 */
export function loadPrompt(section: string): string {
  const cached = cache.get(section);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = path.join(PROMPTS_ROOT, `${section}.md`);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    throw new Error(
      `[REI] Could not load prompt section "${section}". ` +
        `Expected file at: ${filePath}. ` +
        `Check that the prompts/ directory exists and contains the correct markdown files.`,
    );
  }
  cache.set(section, content);
  return content;
}

/**
 * Clears the in-memory prompt cache. Useful in tests or if prompts are
 * edited on disk while the process is running.
 */
export function clearPromptCache(): void {
  cache.clear();
}

// NOTE ONWARD: The following function is not related to prompt loading but is a convenient place to put it since it's used by prompt-building logic and we want to keep all prompt-related code in this directory.
export function loadLocalRules(workspacePath?: string): string {
  const parts: string[] = [];

  // 1. Global REI rules: .rei/rules.md at REI project root (applies to all workspaces)
  const globalRulesPath = path.join(REI_ROOT, ".rei", "rules.md");
  if (fs.existsSync(globalRulesPath)) {
    try {
      const content = fs.readFileSync(globalRulesPath, "utf-8").trim();
      if (content) parts.push(content);
    } catch {
      /* ignore */
    }
  }

  // 2. Per-workspace rules: {workspace}/.rei/rules.md (project-specific conventions)
  const wsPath = workspacePath ?? process.env.REI_WORKSPACE_PATH;
  if (wsPath) {
    const wsRulesPath = path.join(wsPath, ".rei", "rules.md");
    if (fs.existsSync(wsRulesPath)) {
      try {
        const content = fs.readFileSync(wsRulesPath, "utf-8").trim();
        if (content) parts.push(content);
      } catch {
        /* ignore */
      }
    }
  }

  if (parts.length === 0) return "";
  return `\n\n### MANDATORY CODING RULES (Follow strictly):\n${parts.join("\n\n")}`;
}
