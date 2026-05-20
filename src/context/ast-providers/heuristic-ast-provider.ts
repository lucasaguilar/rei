import { AstProvider, AstChunk, DependencyHint, SkeletonNode, SourceFileLike } from "./ast-provider.js";

/**
 * HeuristicAstProvider
 *
 * Fallback provider for unsupported or malformed languages/files.
 * Uses simple heuristics (e.g., function/struct/class regex) to chunk code.
 * Always returns true for supports().
 */
export class HeuristicAstProvider implements AstProvider {
  readonly providerId = "heuristic-ast";

  supports(_file: SourceFileLike): boolean {
    // Always supports any file as a fallback.
    return true;
  }

  async extractChunks(file: SourceFileLike): Promise<AstChunk[]> {
    // Simple heuristic: split by function, class, or struct keywords (very naive)
    const regex = /(class|struct|function|def|fn)\s+([\w$]+)/g;
    const chunks: AstChunk[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(file.content))) {
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: match[1],
        symbolName: match[2],
        startLine: file.content.slice(0, match.index).split("\n").length,
        endLine: 0, // Not tracked in heuristic
        content: match[0],
      });
    }
    return chunks;
  }

  async extractDependencies(_file: SourceFileLike): Promise<DependencyHint[]> {
    // No reliable way to extract dependencies heuristically
    return [];
  }

  async extractSkeleton(file: SourceFileLike): Promise<SkeletonNode[]> {
    // Heuristic: just return the chunk node names/signatures
    const chunks = await this.extractChunks(file);
    return chunks.map(chunk => ({
      nodeType: chunk.nodeType,
      symbolName: chunk.symbolName,
      signature: chunk.content,
    }));
  }
}
