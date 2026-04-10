import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_EXTENSIONS = [
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".html",
  ".css",
  ".scss",
  ".spec.ts",
  ".test.ts",
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
