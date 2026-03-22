import * as fs from "fs";
import * as path from "path";
import type { SessionMode } from "../chat/types.js";
import { scanWorkspace, type FileMeta } from "../workspace/workspace-scanner.js";
import { selectRelevantFiles } from "../workspace/file-selector.js";
import { readFilePreview } from "../workspace/file-preview.js";

export type TurnContext = {
  workspacePath: string;
  repoSummary: string;
  relevantFiles: Array<{
    path: string;
    score: number;
    preview: string;
  }>;
};

const PROJECT_MARKERS = [
  "package.json",
  "tsconfig.json",
  "angular.json",
  "README.md",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
];

export async function buildTurnContext(params: {
  workspacePath: string;
  userInput: string;
  mode: SessionMode;
  scannedFiles?: FileMeta[];
}): Promise<TurnContext> {
  const { workspacePath, userInput, mode, scannedFiles } = params;

  const files = scannedFiles ?? scanWorkspace(workspacePath);
  const repoSummary = await buildRepoSummary(workspacePath, files.map((f) => f.path));
  const selected = selectRelevantFiles(files, userInput, mode);

  const relevantFiles = await Promise.all(
    selected.map(async (f) => ({
      path: f.path,
      score: f.score,
      preview: await readFilePreview(path.join(workspacePath, f.path)),
    }))
  );

  return { workspacePath, repoSummary, relevantFiles };
}

async function buildRepoSummary(workspacePath: string, filePaths: string[]): Promise<string> {
  const lines: string[] = [];

  // Detected project markers
  const detectedMarkers = PROJECT_MARKERS.filter((marker) =>
    fs.existsSync(path.join(workspacePath, marker))
  );
  if (detectedMarkers.length > 0) {
    lines.push(`Project markers: ${detectedMarkers.join(", ")}`);
  }

  // Top-level folders
  const topLevelDirs: string[] = [];
  try {
    const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        topLevelDirs.push(entry.name);
      }
    }
  } catch {
    // ignore
  }
  if (topLevelDirs.length > 0) {
    lines.push(`Top-level folders: ${topLevelDirs.join(", ")}`);
  }

  lines.push(`Total files scanned: ${filePaths.length}`);

  return lines.join("\n");
}
