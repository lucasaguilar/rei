/**
 * Describes the capabilities and features supported by a programming language in the system.
 */
export interface LanguageCapability {
  /**
   * Unique identifier for the language type (currently supported)
   */
  id:
    | "typescript" | "javascript" | "csharp" | "c" | "cpp" | "python" | "rust" | "go" | "php"
    | "luau"
    | "generic-text";

  /**
   * List of file extensions associated with the language (e.g., [".ts", ".js"]).
   */
  extensions: readonly string[];

  /**
   * Indicates if this language should be treated as the main or default source file type
   * when multiple languages are present in a project. For example, if both TypeScript and JavaScript
   * files exist, setting this to true for TypeScript means the system will prioritize TypeScript files
   * for indexing, analysis, or as the primary entry point.
   */
  preferredSourceFile: boolean;

  /**
   * True if AST (Abstract Syntax Tree) indexing is supported for this language.
   */
  supportsAstIndexing: boolean;

  /**
   * True if the system can discover function/method callers for this language.
   */
  supportsCallerDiscovery: boolean;

  /**
   * True if AST-based dependency extraction is supported for this language.
   */
  supportsAstDependencyExtraction: boolean;

  /**
   * True if semantic validation is supported for this language.
   */
  supportsSemanticValidation: boolean;
}
