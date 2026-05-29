
import * as path from "path";
import * as fs from "fs";
import { supportsAstDependencyExtractionPath, getLanguageCapabilityForExtension } from "../language/language-capabilities.js";
import { AstProviderFactory } from "./ast-providers/ast-provider-factory.js";
import { SourceFileLike, AstChunk, DependencyHint } from "./ast-providers/ast-provider.js";
import { HeuristicAstProvider } from "./ast-providers/heuristic-ast-provider.js";

export interface AstContextResult {
  text: string;
  filesScraped: number;
  dependenciesFound: number;
}

/**
 * Maps a file extension to the languageId understood by AstProviderFactory.
 * Delegates to language-capabilities.ts — single source of truth.
 */
function languageIdFromExtension(ext: string): string {
  return getLanguageCapabilityForExtension(ext).id;
}

export async function extractAstDependencies(
  workspacePath: string,
  filePaths: string[],
): Promise<AstContextResult> {
  if (filePaths.length === 0) {
    return { text: "", filesScraped: 0, dependenciesFound: 0 };
  }

  const scrapedDependencies = new Set<string>();
  const outputLines: string[] = [];

  for (const relPath of filePaths) {
    // Gate: skip files whose language has no AST extraction support at all
    if (!supportsAstDependencyExtractionPath(relPath)) continue;

    const absPath = path.resolve(workspacePath, relPath);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, "utf8");
    const ext = path.extname(absPath);
    const languageId = languageIdFromExtension(ext);

    const file: SourceFileLike = {
      filePath: relPath,
      absoluteFilePath: absPath,
      languageId,
      content,
    };

    const provider = AstProviderFactory.resolve(file);
    let dependencies: DependencyHint[] = [];
    let chunks: AstChunk[] = [];
    try {
      dependencies = await provider.extractDependencies(file);
      chunks = await provider.extractChunks(file);
    } catch {
      // Primary provider threw — fall back to HeuristicAstProvider (FR-8)
      try {
        chunks = await new HeuristicAstProvider().extractChunks(file);
      } catch {
        // Skip file entirely
      }
    }

    for (const dep of dependencies) {
      if (scrapedDependencies.has(dep.name)) continue;
      scrapedDependencies.add(dep.name);
      outputLines.push(`\n// [AST Dependency Skeleton] -> ${dep.name}`);
    }
    for (const chunk of chunks) {
      outputLines.push(chunk.content);
    }
  }

  return {
    text: outputLines.join("\n"),
    filesScraped: filePaths.length,
    dependenciesFound: scrapedDependencies.size,
  };
}
