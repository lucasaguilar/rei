import { AstProvider, SourceFileLike } from "./ast-provider.js";
import { TypeScriptAstProvider } from "./typescript-ast-provider.js";
import { TreeSitterAstProvider } from "./tree-sitter-ast-provider.js";
import { HeuristicAstProvider } from "./heuristic-ast-provider.js";

// Add additional providers here as needed
const PROVIDERS: AstProvider[] = [
  new TypeScriptAstProvider(),
  new TreeSitterAstProvider(), // C, C++, C#, Python, Rust, Go
  new HeuristicAstProvider(), // Always keep heuristic last
];

export class AstProviderFactory {
  /**
   * Resolves the best provider for a given file.
   * Returns the first provider that supports the file.
   */
  static resolve(file: SourceFileLike): AstProvider {
    for (const provider of PROVIDERS) {
      if (provider.supports(file)) return provider;
    }
    // Fallback (should never happen, heuristic always returns true)
    return new HeuristicAstProvider();
  }

  /**
   * Returns all available providers (for diagnostics/testing)
   */
  static all(): AstProvider[] {
    return PROVIDERS;
  }
}
