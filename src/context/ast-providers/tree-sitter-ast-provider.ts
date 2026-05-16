import { AstProvider, AstChunk, DependencyHint, SkeletonNode, SourceFileLike } from "./ast-provider.js";
import type { Language, Node as SyntaxNode } from "web-tree-sitter";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import * as path from "path";

const require = createRequire(import.meta.url);

// tsx resolves "web-tree-sitter" to its .d.ts file, making both require() and import()
// return empty objects. Derive the real CJS build path from the resolved .d.ts location
// and require it directly to bypass tsx's module interception.
function loadTreeSitterCjs() {
  const dtsPath = fileURLToPath(import.meta.resolve("web-tree-sitter"));
  const cjsPath = path.join(path.dirname(dtsPath), "tree-sitter.cjs");
  return require(cjsPath) as typeof import("web-tree-sitter");
}

const _ts = loadTreeSitterCjs();
const { Parser, Language: LanguageClass } = _ts;

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

// Container types: emit a structural summary chunk (member list) and recurse to find leaves.
// This avoids duplicating leaf code inside the parent's full text blob.
const CONTAINER_NODE_TYPES: Record<string, string[]> = {
  c: ["struct_specifier", "enum_specifier"],
  cpp: ["class_specifier", "struct_specifier", "enum_specifier"],
  "c++": ["class_specifier", "struct_specifier", "enum_specifier"],
  "c#": ["class_declaration", "interface_declaration", "namespace_declaration"],
  csharp: ["class_declaration", "interface_declaration", "namespace_declaration"],
  python: ["class_definition"],
  rust: ["struct_item", "enum_item", "trait_item"],
  go: ["type_declaration", "struct_type", "interface_type"],
};

// Leaf types: emit full source text and stop recursing (no further nesting expected).
const LEAF_NODE_TYPES: Record<string, string[]> = {
  c: ["function_definition", "typedef"],
  cpp: ["function_definition", "typedef"],
  "c++": ["function_definition", "typedef"],
  "c#": ["method_declaration"],
  csharp: ["method_declaration"],
  python: ["function_definition"],
  rust: ["function_item"],
  go: ["function_declaration"],
};

const grammarCache: Record<string, Language> = {};
// Single shared promise prevents concurrent Parser.init() calls (race condition guard).
let initPromise: Promise<void> | null = null;

export class TreeSitterAstProvider implements AstProvider {
  readonly providerId = "tree-sitter";

  supports(file: SourceFileLike): boolean {
    return Object.keys(LANGUAGE_GRAMMAR_MAP).includes(file.languageId.toLowerCase());
  }

  async ensureGrammar(languageId: string): Promise<Language> {
    if (!initPromise) {
      initPromise = Parser.init();
    }
    await initPromise;
    if (!grammarCache[languageId]) {
      grammarCache[languageId] = await LanguageClass.load(LANGUAGE_GRAMMAR_MAP[languageId]);
    }
    return grammarCache[languageId];
  }

  async extractChunks(file: SourceFileLike): Promise<AstChunk[]> {
    const languageId = file.languageId.toLowerCase();
    const grammar = await this.ensureGrammar(languageId);
    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(file.content);
    if (!tree) return [];
    const containerTypes = CONTAINER_NODE_TYPES[languageId] || [];
    const leafTypes = LEAF_NODE_TYPES[languageId] || [];
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

    // Collect direct named members (leaves and nested containers) for summary content.
    function collectMemberNames(node: SyntaxNode): string[] {
      const names: string[] = [];
      function scan(n: SyntaxNode) {
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          if (!child) continue;
          if (leafTypes.includes(child.type) || containerTypes.includes(child.type)) {
            const name = resolveSymbolName(child);
            if (name) names.push(name);
          } else {
            scan(child);
          }
        }
      }
      scan(node);
      return names;
    }

    // Containers emit a lightweight summary chunk and recurse to find leaves.
    // Leaves emit their full source text with a parentSymbol back-reference.
    // This eliminates the content duplication where a method's text appeared
    // both inside the parent class chunk and as its own chunk.
    function walk(node: SyntaxNode, parentSymbol?: string) {
      if (containerTypes.includes(node.type)) {
        const symbolName = resolveSymbolName(node);
        const members = collectMemberNames(node);
        const memberList = members.length > 0 ? members.join(", ") : "";
        chunks.push({
          filePath: file.filePath,
          languageId: file.languageId,
          providerId: "tree-sitter",
          nodeType: node.type,
          symbolName,
          parentSymbol,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          content: memberList
            ? `${node.type} ${symbolName ?? ""} { members: [${memberList}] }`
            : `${node.type} ${symbolName ?? ""} {}`,
        });
        // Recurse so leaves inside this container get individual chunks.
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child, symbolName);
        }
        return;
      }
      if (leafTypes.includes(node.type)) {
        chunks.push({
          filePath: file.filePath,
          languageId: file.languageId,
          providerId: "tree-sitter",
          nodeType: node.type,
          symbolName: resolveSymbolName(node),
          parentSymbol,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          content: node.text,
        });
        // Don't recurse into leaf nodes — no nested declarations expected.
        return;
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child, parentSymbol);
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
