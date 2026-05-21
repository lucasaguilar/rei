/**
 * Compression utilities to reduce token count and improve TTFT/TPS.
 */

export function slimCode(code: string): string {
  if (!code) return "";

  const lines = code.split("\n");
  const processedLines = lines.map((line) =>
    line
      .replace(/\/\/.*$/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/[ \t]+$/g, ""),
  );

  return (
    processedLines
      .join("\n")
      // Remove excessive empty lines (more than 1)
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function compressSkeletonMap(map: string): string {
  if (!map) return "";
  // Remove unnecessary whitespace in the skeleton map to make it denser
  return map.replace(/\s+/g, " ").trim();
}
