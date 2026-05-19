import * as fs from "fs/promises";

export const PREVIEW_MAX_CHARS_DEFAULT = 500;
export const PREVIEW_MAX_CHARS_AGENT = 1500;
export const PREVIEW_MAX_CHARS_FULL = 60_000;

export async function readFilePreview(
  filePath: string,
  maxChars = PREVIEW_MAX_CHARS_DEFAULT
): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + "\n... (truncated)";
  } catch {
    return "(file could not be read)";
  }
}
