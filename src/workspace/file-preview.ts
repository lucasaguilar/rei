import * as fs from "fs/promises";

export const PREVIEW_MAX_CHARS_DEFAULT = 900;
export const PREVIEW_MAX_CHARS_AGENT = 4000;
export const PREVIEW_MAX_CHARS_FULL = 20_000;

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
