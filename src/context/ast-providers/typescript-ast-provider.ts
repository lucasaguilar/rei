
import { AstProvider, AstChunk, DependencyHint, SkeletonNode, SourceFileLike } from "./ast-provider.js";
import { Project } from "ts-morph";

/**
 * TypeScript/JavaScript provider backed by ts-morph.
 *
 * NOTE: Legacy extractSignatures logic from ast-context was migrated into
 * this provider abstraction so TS/JS parsing quality remains unchanged.
 */
export class TypeScriptAstProvider implements AstProvider {
  readonly providerId = "ts-morph";

  private createSourceFile(project: Project, file: SourceFileLike) {
    if (file.absoluteFilePath) {
      const existing = project.getSourceFile(file.absoluteFilePath);
      if (existing) return existing;
      return project.addSourceFileAtPath(file.absoluteFilePath);
    }

    const sourceText = typeof file.content === "string" ? file.content : "";
    const fallbackExt = file.languageId.toLowerCase().includes("javascript") ? ".js" : ".ts";
    return project.createSourceFile(`source${fallbackExt}`, sourceText, { overwrite: true });
  }

  supports(file: SourceFileLike): boolean {
    return ["typescript", "javascript", "ts", "js"].includes(file.languageId.toLowerCase());
  }

  async extractChunks(file: SourceFileLike): Promise<AstChunk[]> {
    // Use ts-morph to parse the file and extract classes, interfaces, types, functions, variables
    const project = new Project({
      useInMemoryFileSystem: !file.absoluteFilePath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true },
    });
    const sourceFile = this.createSourceFile(project, file);
    const chunks: AstChunk[] = [];
    // Classes
    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName() || "AnonymousClass";
      const startLine = cls.getStartLineNumber();
      const endLine = cls.getEndLineNumber();
      let content = cls.getText();
      const jsDocs = cls.getJsDocs();
      if (jsDocs.length > 0) {
        content = jsDocs.map((j) => j.getText()).join("\n") + "\n" + content;
      }
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "class",
        symbolName: className,
        startLine,
        endLine,
        content,
      });
    }
    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      const ifaceName = iface.getName();
      const startLine = iface.getStartLineNumber();
      const endLine = iface.getEndLineNumber();
      let content = iface.getText();
      const jsDocs = iface.getJsDocs();
      if (jsDocs.length > 0) {
        content = jsDocs.map((j) => j.getText()).join("\n") + "\n" + content;
      }
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "interface",
        symbolName: ifaceName,
        startLine,
        endLine,
        content,
      });
    }
    // Types
    for (const t of sourceFile.getTypeAliases()) {
      const startLine = t.getStartLineNumber();
      const endLine = t.getEndLineNumber();
      let content = t.getText();
      const jsDocs = t.getJsDocs();
      if (jsDocs.length > 0) {
        content = jsDocs.map((j) => j.getText()).join("\n") + "\n" + content;
      }
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "type",
        symbolName: t.getName(),
        startLine,
        endLine,
        content,
      });
    }
    // Functions
    for (const func of sourceFile.getFunctions()) {
      const name = func.getName() || "anonymous";
      const startLine = func.getStartLineNumber();
      const endLine = func.getEndLineNumber();
      let content = func.getText();
      const jsDocs = func.getJsDocs();
      if (jsDocs.length > 0) {
        content = jsDocs.map((j) => j.getText()).join("\n") + "\n" + content;
      }
      chunks.push({
        filePath: file.filePath,
        languageId: file.languageId,
        providerId: this.providerId,
        nodeType: "function",
        symbolName: name,
        startLine,
        endLine,
        content,
      });
    }
    // Variables
    for (const vs of sourceFile.getVariableStatements()) {
      const jsDocs = vs.getJsDocs();
      const docsPrefix = jsDocs.length > 0 ? jsDocs.map((j) => j.getText()).join("\n") + "\n" : "";
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
          content: docsPrefix + vd.getText(),
        });
      }
    }
    return chunks;
  }

  async extractDependencies(file: SourceFileLike): Promise<DependencyHint[]> {
    // Use ts-morph to extract import dependencies
    const project = new Project({
      useInMemoryFileSystem: !file.absoluteFilePath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true },
    });
    const sourceFile = this.createSourceFile(project, file);
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
    const project = new Project({
      useInMemoryFileSystem: !file.absoluteFilePath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true },
    });
    const sourceFile = this.createSourceFile(project, file);
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
