import * as esbuild from "esbuild";

export type MinificationStrategy = "esbuild" | "regex" | "identity";

/**
 * Determines the best minification strategy based on file extension.
 */
export function getStrategyForExtension(ext: string): MinificationStrategy {
  const esbuildExtensions = new Set([".ts", ".js", ".jsx", ".tsx", ".css"]);
  const regexExtensions = new Set([
    ".cs",
    ".cpp",
    ".hpp",
    ".java",
    ".py",
    ".go",
  ]);

  if (esbuildExtensions.has(ext)) return "esbuild";
  if (regexExtensions.has(ext)) return "regex";
  return "identity";
}

/**
 * Performs a safe regex-based cleanup for languages not supported by esbuild.
 * Focuses on removing comments and excessive whitespace without breaking syntax.
 */
function applyRegexMinification(code: string): string {
  return (
    code
      // Remove single line comments (careful with URLs)
      .replace(/([^:]|^)\/\/.*$/gm, "$1")
      // Remove multi-line comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Collapse multiple spaces/tabs to two spaces (maintain minimal structure)
      .replace(/[ \t]{3,}/g, "  ")
      // Remove empty lines
      .replace(/^\s*[\r\n]/gm, "")
      .trim()
  );
}

/**
 * Main entry point for code optimization.
 * Reduces token count while preserving semantic meaning.
 */
export async function optimizeCode(code: string, ext: string): Promise<string> {
  const strategy = getStrategyForExtension(ext);

  switch (strategy) {
    case "esbuild":
      try {
        const result = await esbuild.transform(code, {
          minify: true,
          target: "esnext",
          charset: "utf8",
        });
        return result.code;
      } catch (e) {
        // Fallback to regex if esbuild fails due to syntax errors in partial snippets
        return applyRegexMinification(code);
      }

    case "regex":
      return applyRegexMinification(code);

    case "identity":
    default:
      return code;
  }
}
