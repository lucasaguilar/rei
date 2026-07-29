import * as path from "path";
import { scanWorkspace } from "../../workspace/workspace-scanner.js";
import { MentionEntry } from "../models/chat.types.js";

export function toPosixPath(input: string): string {
  // NOTE: Replace all Windows-style backslashes with POSIX forward slashes
  return input.replace(/\\/g, "/");
}

export function buildMentionEntries(workspacePath: string): MentionEntry[] {
  const files = scanWorkspace(workspacePath);
  const fileSet = new Set<string>();
  const dirSet = new Set<string>();

  for (const file of files) {
    const filePath = toPosixPath(file.path);
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
