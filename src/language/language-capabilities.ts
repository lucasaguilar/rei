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
