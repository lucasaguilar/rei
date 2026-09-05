import * as path from "node:path";
import type { LanguageCapability } from "./language.types.js";

const LANGUAGE_CAPABILITIES: readonly LanguageCapability[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: true,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: true,
  },
  {
    id: "javascript",
    extensions: [".js", ".jsx"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: true,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: true,
  },
  {
    id: "javascript",
    extensions: [".mjs", ".cjs"],
    preferredSourceFile: false,  // transpiled/config variants — not primary source files
    supportsAstIndexing: false,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: false,
    supportsSemanticValidation: false,
  },

  {
    id: "csharp",
    extensions: [".cs"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: true,
  },
  {
    id: "c",
    extensions: [".c", ".h"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: false,
  },
  {
    id: "cpp",
    extensions: [".cpp", ".hpp", ".cc", ".cxx"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: false,
  },
  {
    id: "python",
    extensions: [".py"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: false,
  },
  {
    id: "rust",
    extensions: [".rs"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: false,
  },
  {
    id: "go",
    extensions: [".go"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: false,
  },
  {
    id: "php",
    extensions: [".php"],
    preferredSourceFile: true,
    supportsAstIndexing: true,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: true,
    supportsSemanticValidation: false,
  },
  {
    // Roblox projects. `.luau` is the primary extension; `.lua` appears in older repos and in
    // Lua tooling generally. No AST support here — the point is that these files are RECOGNISED:
    // without an entry the file matcher rejects every path, so a plan's "Files to modify" came
    // back empty and the repo map indexed nothing.
    id: "luau",
    extensions: [".luau", ".lua"],
    preferredSourceFile: true,
    supportsAstIndexing: false,
    supportsCallerDiscovery: false,
    supportsAstDependencyExtraction: false,
    supportsSemanticValidation: false,
  },
];

const DEFAULT_LANGUAGE_CAPABILITY: LanguageCapability = {
  id: "generic-text",
  extensions: [],
  preferredSourceFile: false,
  supportsAstIndexing: false,
  supportsCallerDiscovery: false,
  supportsAstDependencyExtraction: false,
  supportsSemanticValidation: false,
};

const EXTENSION_CAPABILITIES = new Map<string, LanguageCapability>();

for (const capability of LANGUAGE_CAPABILITIES) {
  for (const extension of capability.extensions) {
    EXTENSION_CAPABILITIES.set(extension, capability);
  }
}

function normalizeExtension(extension: string | undefined): string {
  if (!extension) return "";
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

export function getLanguageCapabilityForExtension(
  extension: string | undefined,
): LanguageCapability {
  return (
    EXTENSION_CAPABILITIES.get(normalizeExtension(extension)) ??
    DEFAULT_LANGUAGE_CAPABILITY
  );
}

export function isPreferredSourceExtension(
  extension: string | undefined,
): boolean {
  return getLanguageCapabilityForExtension(extension).preferredSourceFile;
}

export function supportsAstIndexingExtension(
  extension: string | undefined,
): boolean {
  return getLanguageCapabilityForExtension(extension).supportsAstIndexing;
}

export function supportsCallerDiscoveryExtension(
  extension: string | undefined,
): boolean {
  return getLanguageCapabilityForExtension(extension).supportsCallerDiscovery;
}

export function supportsAstDependencyExtractionPath(filePath: string): boolean {
  return getLanguageCapabilityForExtension(path.extname(filePath))
    .supportsAstDependencyExtraction;
}

export function supportsSemanticValidationPath(filePath: string): boolean {
  return getLanguageCapabilityForExtension(path.extname(filePath))
    .supportsSemanticValidation;
}

/**
 * Returns a list of all file extensions supported by REI, both source and configuration files.
 */
export function getAllSupportedExtensions(): string[] {
  const exts = new Set<string>();
  
  // Add extensions from the language registry
  for (const capability of LANGUAGE_CAPABILITIES) {
    for (const extension of capability.extensions) {
      exts.add(extension.replace(/^\./, ""));
    }
  }

  // Common configuration and documentation files
  const commonConfigExts = ["json", "md", "yml", "yaml", "css", "scss", "html", "sh", "txt", "xml", "config", "props", "csproj", "sln", "toml"];
  for (const ext of commonConfigExts) {
    exts.add(ext);
  }

  return Array.from(exts);
}

/**
 * Builds a universal regular expression matching any supported file path with its extension.
 */
export function buildFileMatcherRegex(): RegExp {
  const extensions = getAllSupportedExtensions();
  const escapedExtensions = extensions.map(ext => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`([\\w\\-/]+\\.(?:${escapedExtensions}))`, "gi");
}

/**
 * Returns file extensions (with leading dot) suitable for repo map / RAG indexing:
 * preferred source files (TS, JS, PHP, Python, etc.) plus web markup and styles.
 * Single source of truth consumed by file-globber.ts, repo-map-generator.ts, and
 * the chokidar watcher in repo-map-indexer.ts.
 */
export function getSourceFileExtensions(): string[] {
  const sourceExts: string[] = [];
  for (const capability of LANGUAGE_CAPABILITIES) {
    if (capability.preferredSourceFile) {
      for (const ext of capability.extensions) {
        sourceExts.push(ext);
      }
    }
  }
  // Web markup and styles (not in LANGUAGE_CAPABILITIES but always indexed)
  const webExts = [".html", ".css", ".scss"];
  for (const ext of webExts) {
    if (!sourceExts.includes(ext)) sourceExts.push(ext);
  }
  return sourceExts;
}

/**
 * Returns chokidar-compatible glob patterns for all source file extensions.
 * Used by the FS watcher in repo-map-indexer.ts.
 */
export function getWatcherGlobs(): string[] {
  return getSourceFileExtensions().map(ext => `**/*${ext}`);
}

/**
 * Returns file extensions (with leading dot) for polyglot languages — i.e.,
 * source files that are NOT TypeScript / JavaScript and are processed by Tree-sitter.
 * Used by repo-map-generator.ts to separate the polyglot pipeline from ts-morph.
 */
export function getPolyglotExtensions(): string[] {
  return LANGUAGE_CAPABILITIES
    .filter(cap => cap.preferredSourceFile && cap.supportsAstIndexing && cap.id !== "typescript" && cap.id !== "javascript")
    .flatMap(cap => cap.extensions);
}

