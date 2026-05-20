import * as esbuild from "esbuild";

/**
 * Performs deep minification of JS/TS code using esbuild.
 * Preserves identifiers to maintain compatibility with symbol search and caller graphs.
 */
export async function deepMinify(
  code: string,
  language: string,
): Promise<string> {
  // Only attempt minification for JS/TS files
  if (
    !["typescript", "javascript", "ts", "js"].includes(language.toLowerCase())
  ) {
    return code;
  }

  try {
    const result = await esbuild.transform(code, {
      loader: language.toLowerCase().includes("ts") ? "ts" : "js",
      minifyWhitespace: true,
      minifyIdentifiers: false, // CRITICAL: Keep names for LLM symbol recognition
      minifySyntax: true,
      target: "esnext",
    });

    return result.code;
  } catch (error) {
    // Fallback to original code if esbuild fails (e.g. syntax error in snippet)
    return code;
  }
}
