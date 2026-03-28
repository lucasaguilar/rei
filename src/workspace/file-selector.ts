import type { FileMeta } from "./workspace-scanner.js";
import type { SessionMode } from "../chat/types.js";

export type RankedFile = FileMeta & {
  score: number;
};

const TOP_FILES_LIMIT = 6;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function selectRelevantFiles(
  files: FileMeta[],
  userInput: string,
  mode: SessionMode
): RankedFile[] {
  const keywords = extractKeywords(userInput);

  const ranked: RankedFile[] = files.map((file) => ({
    ...file,
    score: scoreFile(file, keywords, mode),
  }));

  const selected = ranked
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_FILES_LIMIT);

  if (selected.length > 0) {
    return selected;
  }

  if (mode === "ask") {
    return fallbackAskFiles(files);
  }

  return [];
}

function fallbackAskFiles(files: FileMeta[]): RankedFile[] {
  const priorityFiles = ["README.md", "package.json", "tsconfig.json"];

  const rankFallback = (file: FileMeta): number => {
    const pathLower = file.path.toLowerCase();
    const nameLower = file.name.toLowerCase();

    let score = 0;
    if (pathLower.startsWith("src/")) score += 6;
    if (SOURCE_EXTENSIONS.has(file.extension)) score += 4;

    for (let i = 0; i < priorityFiles.length; i += 1) {
      if (nameLower === priorityFiles[i].toLowerCase()) {
        score += 3 - i;
      }
    }

    return score;
  };

  return files
    .map((file) => ({
      ...file,
      score: rankFallback(file),
    }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_FILES_LIMIT);
}

function extractKeywords(input: string): string[] {
  return input
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
}

function scoreFile(file: FileMeta, keywords: string[], mode: SessionMode): number {
  let score = 0;

  const nameLower = file.name.toLowerCase();
  const pathLower = file.path.toLowerCase();

  for (const keyword of keywords) {
    if (nameLower.includes(keyword)) score += 3;
    if (pathLower.includes(keyword)) score += 1;
  }

  // Mode-based boosts: agent mode prefers source files, planning mode prefers docs
  if (mode === "agent" || mode === "planning" || mode === "ask") {
    if (SOURCE_EXTENSIONS.has(file.extension)) score += 1;
  }
  if (mode === "planning") {
    if (nameLower === "readme.md" || nameLower === "package.json") score += 2;
  }

  return score;
}
