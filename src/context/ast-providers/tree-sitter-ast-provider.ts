import { AstProvider, AstChunk, DependencyHint, SkeletonNode, SourceFileLike } from "./ast-provider.js";
import type { Language, Node as SyntaxNode } from "web-tree-sitter";
import { createRequire } from "module";
import { readFileSync } from "node:fs";
import * as path from "path";

const require = createRequire(import.meta.url);
const TreeSitter = require("web-tree-sitter") as typeof import("web-tree-sitter");

// WASM grammar files shipped by tree-sitter-wasms (zero native build tools required)
function grammarPath(name: string): string {
  const wasmDir = path.dirname(require.resolve("tree-sitter-wasms/package.json"));
  return path.join(wasmDir, "out", `tree-sitter-${name}.wasm`);
}

// languageId -> wasm grammar file path
const LANGUAGE_GRAMMAR_MAP: Record<string, string> = {
  c: grammarPath("c"),
  cpp: grammarPath("cpp"),
  "c++": grammarPath("cpp"),
  "c#": grammarPath("c_sharp"),
  csharp: grammarPath("c_sharp"),
  python: grammarPath("python"),
  rust: grammarPath("rust"),
  go: grammarPath("go"),
};

const NODE_TYPES: Record<string, string[]> = {
  c: ["function_definition", "struct_specifier", "enum_specifier", "typedef"],
  cpp: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier", "typedef"],
  "c++": ["function_definition", "class_specifier", "struct_specifier", "enum_specifier", "typedef"],
  "c#": ["class_declaration", "method_declaration", "interface_declaration", "namespace_declaration"],
  csharp: ["class_declaration", "method_declaration", "interface_declaration", "namespace_declaration"],
  python: ["function_definition", "class_definition"],
  rust: ["function_item", "struct_item", "enum_item", "trait_item"],
  go: ["function_declaration", "type_declaration", "struct_type", "interface_type"],
};

const grammarCache: Record<string, Language> = {};
let treeSitterInitialized = false;

export class TreeSitterAstProvider implements AstProvider {
  readonly providerId = "tree-sitter";

  supports(file: SourceFileLike): boolean {
    return Object.keys(LANGUAGE_GRAMMAR_MAP).includes(file.languageId.toLowerCase());
  }

  async ensureGrammar(languageId: string): Promise<Language> {
    if (!treeSitterInitialized) {
      // Parser.init() locates web-tree-sitter.wasm relative to the package automatically
      await TreeSitter.Parser.init();
      treeSitterInitialized = true;
    }
    if (!grammarCache[languageId]) {
      // Read as Uint8Array to bypass fetch()/URL resolution on Windows paths
      const wasmBytes = readFileSync(LANGUAGE_GRAMMAR_MAP[languageId]);
      grammarCache[languageId] = await TreeSitter.Language.load(wasmBytes);
    }
    return grammarCache[languageId];
  }

  async extractChunks(file: SourceFileLike): Promise<AstChunk[]> {
    const languageId = file.languageId.toLowerCase();
    const grammar = await this.ensureGrammar(languageId);
    const parser = new TreeSitter.Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(file.content);
    if (!tree) return [];
    const nodeTypes = NODE_TYPES[languageId] || [];
    const chunks: AstChunk[] = [];
    // Name field differs by language; C/C++ nest name inside declarator chain
    function resolveSymbolName(node: SyntaxNode): string | undefined {
      const direct = node.childForFieldName("name");
      if (direct) return direct.text;
      const decl = node.childForFieldName("declarator");
      if (decl) return resolveSymbolName(decl);
      if (node.type === "identifier" || node.type === "type_identifier") return node.text;
      return undefined;
    }
    function walk(node: SyntaxNode) {
      if (nodeTypes.includes(node.type)) {
        chunks.push({
          filePath: file.filePath,
          languageId: file.languageId,
          providerId: "tree-sitter",
          nodeType: node.type,
          symbolName: resolveSymbolName(node),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          content: node.text,
        });
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child);
      }
    }
    walk(tree.rootNode);
    return chunks;
  }

  async extractDependencies(file: SourceFileLike): Promise<DependencyHint[]> {
    const languageId = file.languageId.toLowerCase();
    const dependencies: DependencyHint[] = [];
    if (languageId === "c" || languageId === "cpp" || languageId === "c++") {
      // #include "..."
      const includeRegex = /#include\s+["<]([^">]+)[">]/g;
      let match: RegExpExecArray | null;
      while ((match = includeRegex.exec(file.content))) {
        dependencies.push({ kind: "include", name: match[1], raw: match[0] });
      }
    } else if (languageId === "python") {
      // from ... import ... or import ...
      const importRegex = /(?:from|import)\s+([\w\.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(file.content))) {
        dependencies.push({ kind: "import", name: match[1], raw: match[0] });
      }
    } else if (languageId === "rust") {
      // use ...
      const useRegex = /use\s+([\w\:]+)/g;
      let match: RegExpExecArray | null;
      while ((match = useRegex.exec(file.content))) {
        dependencies.push({ kind: "import", name: match[1], raw: match[0] });
      }
    } else if (languageId === "go") {
      // import "..."
      const importRegex = /import\s+"([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(file.content))) {
        dependencies.push({ kind: "import", name: match[1], raw: match[0] });
      }
    } else if (languageId === "c#" || languageId === "csharp") {
      // using ...
      const usingRegex = /using\s+([\w\.]+)\s*;/g;
      let match: RegExpExecArray | null;
      while ((match = usingRegex.exec(file.content))) {
        dependencies.push({ kind: "using", name: match[1], raw: match[0] });
      }
    }
    return dependencies;
  }

  async extractSkeleton(file: SourceFileLike): Promise<SkeletonNode[]> {
    try {
      const chunks = await this.extractChunks(file);
      return chunks.map((chunk) => ({
        nodeType: chunk.nodeType,
        symbolName: chunk.symbolName,
        signature: chunk.content,
      }));
    } catch {
      return [];
    }
  }
}
