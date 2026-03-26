import * as fs from "fs/promises";

const DEFAULT_MAX_CHARS = 200;

export async function readFilePreview(
  filePath: string,
  maxChars = DEFAULT_MAX_CHARS
): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + "\n... (truncated)";
  } catch {
    return "(file could not be read)";
  }
}
