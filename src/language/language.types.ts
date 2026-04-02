export interface LanguageCapability {
  id: "typescript" | "javascript" | "generic-text";
  extensions: readonly string[];
  preferredSourceFile: boolean;
  supportsAstIndexing: boolean;
  supportsCallerDiscovery: boolean;
  supportsAstDependencyExtraction: boolean;
  supportsSemanticValidation: boolean;
}
