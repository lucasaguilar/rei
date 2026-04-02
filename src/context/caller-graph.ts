import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileMeta } from '../workspace/workspace-scanner.js';

export interface CallerReference {
  filePath: string;
  symbolName: string;
  line: number;
  snippet: string;
}

// Words to ignore when extracting identifiers from user prompts
const STOPWORDS = new Set([
  'the', 'and', 'for', 'not', 'that', 'this', 'with', 'from', 'into',
  'have', 'been', 'will', 'also', 'when', 'where', 'what', 'which',
  'return', 'function', 'class', 'interface', 'type', 'const', 'let',
  'var', 'async', 'await', 'import', 'export', 'default', 'true', 'false',
  // Spanish
  'que', 'como', 'donde', 'cuando', 'para', 'una', 'del', 'los', 'las',
  'por', 'con', 'sin', 'sobre', 'desde', 'hasta', 'este', 'esta',
  'tambien', 'todo', 'todos', 'archivo', 'funcion', 'clase', 'retorno',
  'cambio', 'cambia', 'modifica', 'agrega', 'elimina', 'actualiza',
]);

const INDEXABLE_CALLER_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * Extracts identifiers that look like code symbols (camelCase / PascalCase)
 * from a natural language user prompt.
 */
export function extractSymbolHints(userInput: string): string[] {
  // Match camelCase, PascalCase, and snake_case identifiers of at least 4 chars
  const candidates = userInput.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]{3,})\b/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of candidates) {
    if (seen.has(token)) continue;
    seen.add(token);

    if (STOPWORDS.has(token.toLowerCase())) continue;
    // Must look like a code identifier: has a capital or underscore, or is camelCase
    const looksLikeCode =
      /[A-Z]/.test(token) ||         // PascalCase or camelCase with uppercase
      token.includes('_') ||          // snake_case
      /[a-z][A-Z]/.test(token);       // camelCase transition

    if (looksLikeCode) {
      result.push(token);
    }
  }

  return result;
}

/**
 * Scans workspace files for references to a set of symbol names.
 * Uses word-boundary matching for precision. Fast enough for projects up to ~5k files.
 */
export function findSymbolCallers(params: {
  workspacePath: string;
  symbolNames: string[];
  excludeFile?: string;
  scannedFiles: FileMeta[];
  maxResults?: number;
}): CallerReference[] {
  const { workspacePath, symbolNames, excludeFile, scannedFiles, maxResults = 20 } = params;
  if (symbolNames.length === 0) return [];

  const results: CallerReference[] = [];
  // Pre-compile one regex per symbol for word-boundary matching
  const patterns = symbolNames.map((name) => ({
    name,
    re: new RegExp(`\\b${escapeRegex(name)}\\b`),
  }));

  for (const file of scannedFiles) {
    if (results.length >= maxResults) break;
    if (!INDEXABLE_CALLER_EXTS.has(file.extension)) continue;
    if (excludeFile && normalizeRelPath(file.path) === normalizeRelPath(excludeFile)) continue;

    const absPath = path.join(workspacePath, file.path);
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const foundSymbols = new Set<string>();

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const { name, re } of patterns) {
        if (foundSymbols.has(name)) continue; // one entry per symbol per file
        if (re.test(line)) {
          foundSymbols.add(name);
          results.push({
            filePath: file.path,
            symbolName: name,
            line: lineIdx + 1,
            snippet: line.trim().slice(0, 120),
          });
          if (results.length >= maxResults) break;
        }
      }
      if (results.length >= maxResults) break;
    }
  }

  return results;
}

/**
 * Returns unique file paths from a set of CallerReferences, ordered by
 * number of matched symbols (most referenced files first).
 */
export function rankCallerFiles(refs: CallerReference[]): string[] {
  const countByFile = new Map<string, number>();
  for (const ref of refs) {
    countByFile.set(ref.filePath, (countByFile.get(ref.filePath) ?? 0) + 1);
  }
  return [...countByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([filePath]) => filePath);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}
