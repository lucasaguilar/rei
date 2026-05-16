/**
# AST Provider Abstraction

## Overview

The `AstProvider` abstraction defines the parser contract for the **Hybrid AST Context Engine**.

Its purpose is to provide a normalized interface for language-aware structural code analysis, independent of the underlying parsing technology.

This allows REI to support multiple AST engines while keeping the context pipeline parser-agnostic.

Examples:

- TypeScript / JavaScript → `ts-morph`
- C / C++ / C# / Python / Go / Rust → `web-tree-sitter`
- Unsupported languages → heuristic fallback provider

---

## Design Goals

The abstraction is designed to:

- normalize AST extraction across languages
- support multiple parser backends
- improve context generation quality
- avoid parser-specific coupling in the agent pipeline
- enable incremental language support

This layer is focused on **structural understanding**, not semantic correctness.

---

## Core Interfaces

### `AstChunk`

Represents a structural code unit extracted from a source file.

Examples:

- class
- function
- method
- interface
- struct
- enum

```ts
export interface AstChunk {
  filePath: string;
  languageId: string;
  nodeType: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  content: string;
}
```
*/

export interface AstChunk {
  filePath: string;
  languageId: string;
  providerId: string;
  nodeType: string;
  symbolName?: string;
  /** Symbol name of the enclosing container (class, namespace, etc.), if any. */
  parentSymbol?: string;
  startLine: number;
  endLine: number;
  content: string;
}


export interface DependencyHint {
  kind: "import" | "include" | "using" | "module";
  name: string;
  raw: string;
}

export interface SkeletonNode {
  nodeType: string;
  symbolName?: string;
  signature: string;
}

export interface SourceFileLike {
  filePath: string;
  languageId: string;
  content: string;
}


export interface AstProvider {
  supports(file: SourceFileLike): boolean;

  extractChunks(file: SourceFileLike): Promise<AstChunk[]>;

  extractDependencies(file: SourceFileLike): Promise<DependencyHint[]>;

  extractSkeleton(file: SourceFileLike): Promise<SkeletonNode[]>;
}
