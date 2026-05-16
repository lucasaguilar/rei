import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_EXTENSIONS = [
  // TypeScript / JavaScript
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".spec.ts",
  ".test.ts",
  // Web
  ".html",
  ".css",
  ".scss",
  // Polyglot (Tree-sitter supported)
  ".py",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cxx",
  ".cs",
  ".rs",
  ".go",
];

export function listRelevantFiles(
  rootDir: string,
  exts: string[] = DEFAULT_EXTENSIONS,
): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        walk(fullPath);
      } else {
        if (exts.some((ext) => entry.name.endsWith(ext))) {
          results.push(fullPath);
        }
      }
    }
  }
  walk(rootDir);
  return results;
}
