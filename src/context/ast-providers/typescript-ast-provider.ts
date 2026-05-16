
import { AstProvider, AstChunk, DependencyHint, SkeletonNode, SourceFileLike } from "./ast-provider.js";
import { Project } from "ts-morph";

export class TypeScriptAstProvider implements AstProvider {
  readonly providerId = "ts-morph";

  supports(file: SourceFileLike): boolean {
    return ["typescript", "javascript", "ts", "js"].includes(file.languageId.toLowerCase());
  }

  async extractChunks(file: SourceFileLike): Promise<AstChunk[]> {
    // Use ts-morph to parse the file and extract classes, interfaces, types, functions, variables
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(file.filePath, file.content, { overwrite: true });
    const chunks: AstChunk[] = [];
    // Classes
    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue;
      const className = cls.getName() || "AnonymousClass";
      const startLine = cls.getStartLineNumber();
      const endLine = cls.getEndLineNumber();
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "class",
        symbolName: className,
        startLine,
        endLine,
        content: cls.getText(),
      });
    }
    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      if (!iface.isExported()) continue;
      const ifaceName = iface.getName();
      const startLine = iface.getStartLineNumber();
      const endLine = iface.getEndLineNumber();
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "interface",
        symbolName: ifaceName,
        startLine,
        endLine,
        content: iface.getText(),
      });
    }
    // Types
    for (const t of sourceFile.getTypeAliases()) {
      if (!t.isExported()) continue;
      const startLine = t.getStartLineNumber();
      const endLine = t.getEndLineNumber();
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "type",
        symbolName: t.getName(),
        startLine,
        endLine,
        content: t.getText(),
      });
    }
    // Functions
    for (const func of sourceFile.getFunctions()) {
      if (!func.isExported()) continue;
      const name = func.getName() || "anonymous";
      const startLine = func.getStartLineNumber();
      const endLine = func.getEndLineNumber();
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "function",
        symbolName: name,
        startLine,
        endLine,
        content: func.getText(),
      });
    }
    // Variables (exported)
    for (const vs of sourceFile.getVariableStatements()) {
      if (!vs.isExported()) continue;
      for (const vd of vs.getDeclarations()) {
        const startLine = vd.getStartLineNumber();
        const endLine = vd.getEndLineNumber();
        chunks.push({
          filePath: file.filePath,
          languageId: file.languageId,
          providerId: this.providerId,
          nodeType: "variable",
          symbolName: vd.getName(),
          startLine,
          endLine,
          content: vd.getText(),
        });
      }
    }
    return chunks;
  }

  async extractDependencies(file: SourceFileLike): Promise<DependencyHint[]> {
    // Use ts-morph to extract import dependencies
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(file.filePath, file.content, { overwrite: true });
    const dependencies: DependencyHint[] = [];
    for (const imp of sourceFile.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      dependencies.push({
        kind: "import",
        name: spec,
        raw: imp.getText(),
      });
    }
    return dependencies;
  }

  async extractSkeleton(file: SourceFileLike): Promise<SkeletonNode[]> {
    // Use ts-morph to extract skeleton nodes (signatures only)
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile(file.filePath, file.content, { overwrite: true });
    const skeleton: SkeletonNode[] = [];
    // Classes
    for (const cls of sourceFile.getClasses()) {
      if (!cls.isExported()) continue;
      skeleton.push({
        nodeType: "class",
        symbolName: cls.getName() || "AnonymousClass",
        signature: cls.getText(),
      });
    }
    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      if (!iface.isExported()) continue;
      skeleton.push({
        nodeType: "interface",
        symbolName: iface.getName(),
        signature: iface.getText(),
      });
    }
    // Types
    for (const t of sourceFile.getTypeAliases()) {
      if (!t.isExported()) continue;
      skeleton.push({
        nodeType: "type",
        symbolName: t.getName(),
        signature: t.getText(),
      });
    }
    // Functions
    for (const func of sourceFile.getFunctions()) {
      if (!func.isExported()) continue;
      skeleton.push({
        nodeType: "function",
        symbolName: func.getName() || "anonymous",
        signature: func.getText(),
      });
    }
    // Variables
    for (const vs of sourceFile.getVariableStatements()) {
      if (!vs.isExported()) continue;
      for (const vd of vs.getDeclarations()) {
        skeleton.push({
          nodeType: "variable",
          symbolName: vd.getName(),
          signature: vd.getText(),
        });
      }
    }
    return skeleton;
  }
}
