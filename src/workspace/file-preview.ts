import * as fs from "fs/promises";

export const PREVIEW_MAX_CHARS_DEFAULT = 500;
export const PREVIEW_MAX_CHARS_AGENT = 1500;
export const PREVIEW_MAX_CHARS_FULL = 12_000;

function slimContent(text: string): string {
  return text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\n/gm, "")
    .replace(/[ \t]+$/gm, "");
}

export async function readFilePreview(
  filePath: string,
  maxChars = PREVIEW_MAX_CHARS_DEFAULT,
  slim = false,
): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const content = slim ? slimContent(raw) : raw;
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + "\n... (truncated)";
  } catch {
    return "(file could not be read)";
  }
}
