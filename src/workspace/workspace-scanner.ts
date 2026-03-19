import * as fs from "fs";
import * as path from "path";

export type FileMeta = {
  path: string;
  name: string;
  extension: string;
};

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".rei",
]);

const IGNORED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".mp4",
  ".mp3",
  ".wav",
  ".zip",
  ".tar",
  ".gz",
  ".lock",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);

const MAX_FILES = 200;

export function scanWorkspace(workspacePath: string): FileMeta[] {
  const results: FileMeta[] = [];
  collectFiles(workspacePath, workspacePath, results);
  return results;
}

function collectFiles(
  workspacePath: string,
  currentPath: string,
  results: FileMeta[]
): void {
  if (results.length >= MAX_FILES) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectFiles(workspacePath, path.join(currentPath, entry.name), results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) continue;
      results.push({
        path: path.relative(workspacePath, path.join(currentPath, entry.name)),
        name: entry.name,
        extension: ext,
      });
    }
  }
}
