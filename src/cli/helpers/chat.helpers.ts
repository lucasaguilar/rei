import * as fs from "fs";
import * as path from "path";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";
import { MentionEntry } from "../models/chat.types.js";

export function toPosixPath(input: string): string {
  // NOTE: Replace all Windows-style backslashes with POSIX forward slashes
  return input.replace(/\\/g, "/");
}

// User-authored artifacts under .rei/ that the workspace scanner deliberately ignores (it skips all
// dot-dirs so REI's logs/sessions never pollute the RAG/repo-map). Plans, specs and their reviews DO
// belong in the @ picker so a role/turn can reference them (e.g. `@.rei/plans/x.md`). Reviews live
// next to their plan (.rei/plans/<name>.review.md), so listing .rei/plans covers them too.
const REI_ARTIFACT_DIRS = [".rei/plans", ".rei/specs"];

function scanReiArtifacts(workspacePath: string): string[] {
  const out: string[] = [];
  for (const rel of REI_ARTIFACT_DIRS) {
    try {
      for (const f of fs.readdirSync(path.join(workspacePath, rel))) {
        if (f.endsWith(".md")) out.push(`${rel}/${f}`);
      }
    } catch {
      // dir doesn't exist yet — fine
    }
  }
  return out;
}

export function buildMentionEntries(workspacePath: string): MentionEntry[] {
  const scanned = scanWorkspace(workspacePath).map((f) => toPosixPath(f.path));
  const allPaths = [...scanned, ...scanReiArtifacts(workspacePath)];
  const fileSet = new Set<string>();
  const dirSet = new Set<string>();

  for (const filePath of allPaths) {
    fileSet.add(filePath);

    let currentDir = path.posix.dirname(filePath);
    while (currentDir && currentDir !== ".") {
      dirSet.add(`${currentDir}/`);
      const parent = path.posix.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  }

  const dirs = Array.from(dirSet)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, description: "folder", isDir: true }));

  const regularFiles = Array.from(fileSet)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, description: "file", isDir: false }));

  return [...dirs, ...regularFiles];
}

export function displayUserLabel(displayLabel: string): string {
  // NOTE \x1b[1;36m is ANSI escape code for bold cyan text
  // NOTE \x1b[0m is ANSI escape code for reset to default text
  return `\x1b[1;36mYou: ${displayLabel}\x1b[0m`;
}
