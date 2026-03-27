import { createTwoFilesPatch } from "diff";

export interface PatchGenerationOptions {
  contextLines?: number;
}

export interface ExtractedPatchInfo {
  file: string;
  oldFile: string;
  newFile: string;
  hunkCount: number;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";

/**
 * Generate a unified diff patch for a single workspace-relative file.
 */
export function generateUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  options: PatchGenerationOptions = {}
): string {
  if (before === after) {
    return "";
  }

  const normalized = normalizeFilePath(filePath);
  const contextLines = options.contextLines ?? 3;

  const rawPatch = createTwoFilesPatch(
    `a/${normalized}`,
    `b/${normalized}`,
    before,
    after,
    "",
    "",
    { context: contextLines }
  );

  return ensurePatchEndsWithNewline(stripPatchPreamble(rawPatch));
}

/**
 * Colorize unified diff output for terminal display.
 */
export function formatPatchForTerminal(diffText: string): string {
  if (!diffText.trim()) {
    return `${ANSI_DIM}(no changes)${ANSI_RESET}`;
  }

  return diffText
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) return `${ANSI_YELLOW}${line}${ANSI_RESET}`;
      if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        return `${ANSI_CYAN}${line}${ANSI_RESET}`;
      }
      if (line.startsWith("+")) return `${ANSI_GREEN}${line}${ANSI_RESET}`;
      if (line.startsWith("-")) return `${ANSI_RED}${line}${ANSI_RESET}`;
      return line;
    })
    .join("\n");
}

/**
 * Extract basic metadata from a unified diff patch.
 */
export function extractFileFromPatch(diffText: string): ExtractedPatchInfo | null {
  const lines = diffText.split("\n");
  const oldLine = lines.find((line) => line.startsWith("--- "));
  const newLine = lines.find((line) => line.startsWith("+++ "));

  if (!oldLine || !newLine) {
    return null;
  }

  const oldFile = oldLine.slice(4).trim();
  const newFile = newLine.slice(4).trim();
  const hunkCount = lines.filter((line) => line.startsWith("@@")).length;

  const file = newFile.startsWith("b/") ? newFile.slice(2) : newFile;
  return { file, oldFile, newFile, hunkCount };
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function stripPatchPreamble(patchText: string): string {
  const lines = patchText.split("\n");
  const firstHeaderIndex = lines.findIndex(
    (line) => line.startsWith("--- ") || line.startsWith("diff --git ")
  );

  if (firstHeaderIndex === -1) {
    return patchText;
  }

  return lines.slice(firstHeaderIndex).join("\n");
}

function ensurePatchEndsWithNewline(patchText: string): string {
  return patchText.endsWith("\n") ? patchText : `${patchText}\n`;
}
