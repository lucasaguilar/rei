import * as fs from "node:fs";
import * as path from "node:path";
import {
  Node,
  Project,
  PropertySignature,
  SourceFile,
  SyntaxKind,
  TypeAliasDeclaration,
} from "ts-morph";
import { listRelevantFiles } from "./file-globber.js";
import { AstProviderFactory } from "../context/ast-providers/ast-provider-factory.js";
import type { SourceFileLike, AstChunk } from "../context/ast-providers/ast-provider.js";
import { HeuristicAstProvider } from "../context/ast-providers/heuristic-ast-provider.js";
import { getLanguageCapabilityForExtension } from "../language/language-capabilities.js";

// Detect entry points from package.json
function getEntryPointFiles(workspacePath: string): Set<string> {
  const entryPoints = new Set<string>();
  try {
    const pkgPath = path.join(workspacePath, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.main) entryPoints.add(path.resolve(workspacePath, pkg.main));
      if (pkg.bin) {
        if (typeof pkg.bin === "string")
          entryPoints.add(path.resolve(workspacePath, pkg.bin));
        else if (typeof pkg.bin === "object") {
          for (const k in pkg.bin)
            entryPoints.add(path.resolve(workspacePath, pkg.bin[k]));
        }
      }
    }
  } catch {}
  // Add common entry point filenames
  ["main.ts", "main.js", "index.ts", "index.js"].forEach((f) => {
    entryPoints.add(path.resolve(workspacePath, f));
  });
  return entryPoints;
}

const REPO_MAP_HEADER = "### REPOSITORY SKELETON MAP";

export async function generateRepoMap(workspacePath: string): Promise<string> {
  // NOTE 1. Filtro de carpetas prohibidas
  const IGNORE_DIRS = ["node_modules", "dist", ".rei", ".git", "bin", "obj"];

  const files = listRelevantFiles(workspacePath).filter(
    (file) => !IGNORE_DIRS.some((dir) => file.split(path.sep).includes(dir)),
  );

  const entryPointFiles = getEntryPointFiles(workspacePath);
  const tsFiles = files.filter((f) => /\.(ts|js|tsx|jsx)$/.test(f));
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  const cssFiles = files.filter(
    (f) => f.endsWith(".css") || f.endsWith(".scss"),
  );
  const testFiles = files.filter((f) =>
    /\.(spec|test)\.(ts|js|tsx|jsx)$/.test(f),
  );
  const polyglotFiles = files.filter((f) =>
    /\.(py|c|h|cpp|hpp|cc|cxx|cs|rs|go)$/.test(f),
  );

  // Procesar archivos TS/JS con ts-morph
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFilesAtPaths(tsFiles);
  const sourceFiles = project.getSourceFiles();

  const sections: string[] = [];

  for (const sourceFile of sourceFiles) {
    const section = renderSourceFile(
      workspacePath,
      sourceFile,
      entryPointFiles,
    );
    if (section) sections.push(section);
  }

  // HTML
  for (const file of htmlFiles) {
    const relPath = path.relative(workspacePath, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf8");
    const tags = Array.from(content.matchAll(/<([a-zA-Z0-9\-]+)/g))
      .map((m) => m[1]) // Filtramos etiquetas genéricas para resaltar componentes (tags con guion o especiales)
      .filter(
        (tag) =>
          tag.includes("-") ||
          ![
            "div",
            "span",
            "p",
            "b",
            "i",
            "tr",
            "td",
            "table",
            "form",
            "input",
          ].includes(tag.toLowerCase()),
      );
    sections.push(
      `// FILE: ${relPath}\nRelevant Tags: ${[...new Set(tags)].join(", ")}`,
    );
  }

  // CSS/SCSS
  for (const file of cssFiles) {
    const relPath = path.relative(workspacePath, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf8");
    const classes = Array.from(content.matchAll(/\.(\w[\w-]*)/g)).map(
      (m) => m[1],
    );
    const ids = Array.from(content.matchAll(/#(\w[\w-]*)/g)).map((m) => m[1]);
    sections.push(
      `// FILE: ${relPath}\nCSS classes: ${[...new Set(classes)].join(", ")}\nCSS ids: ${[...new Set(ids)].join(", ")}`,
    );
  }

  // TESTS
  for (const file of testFiles) {
    const relPath = path.relative(workspacePath, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf8");
    const describes = Array.from(
      content.matchAll(/describe\s*\(\s*['"`]([^'"]+)['"`]/g),
    ).map((m) => m[1]);
    const its = Array.from(
      content.matchAll(/(?:it|test)\s*\(\s*['"`]([^'"]+)['"`]/g),
    ).map((m) => m[1]);
    sections.push(
      `// FILE: ${relPath}\nTest suites: ${[...new Set(describes)].join(", ")}\nTest cases: ${[...new Set(its)].join(", ")}`,
    );
  }

  // POLYGLOT (C, C++, C#, Python, Rust, Go) — AstProviderFactory / Tree-sitter
  for (const file of polyglotFiles) {
    const relPath = path.relative(workspacePath, file).replace(/\\/g, "/");
    try {
      const content = fs.readFileSync(file, "utf8");
      const ext = path.extname(file).toLowerCase();
      const languageId = getLanguageCapabilityForExtension(ext).id;
      const fileLike: SourceFileLike = {
        filePath: relPath,
        absoluteFilePath: file,
        languageId,
        content,
      };
      const provider = AstProviderFactory.resolve(fileLike);
      let chunks: AstChunk[] = [];
      try {
        chunks = await provider.extractChunks(fileLike);
      } catch { /* Tree-sitter failed; heuristic fallback below */ }
      if (chunks.length === 0) {
        // FR-8: heuristic fallback when Tree-sitter fails or returns no symbols
        try { chunks = await new HeuristicAstProvider().extractChunks(fileLike); } catch { /* skip */ }
      }
      if (chunks.length > 0) {
        const lines = chunks.map(
          (c) => `[${c.providerId}] ${c.nodeType} "${c.symbolName ?? "?"}" (L${c.startLine}-${c.endLine})`,
        );
        sections.push(`// FILE: ${relPath}\n${lines.join("\n")}`);
      } else {
        sections.push(`// FILE: ${relPath}`);
      }
    } catch {
      sections.push(`// FILE: ${relPath}`);
    }
  }

  const skeleton =
    sections.length > 0
      ? `${REPO_MAP_HEADER}\n\n${sections.join("\n\n")}`
      : `${REPO_MAP_HEADER}\n\n(No relevant declarations found.)`;

  // DEBUG: Write skeleton map to disk for inspection
  try {
    const logPath = path.join(workspacePath, ".rei/logs/repo-skeleton-map.txt");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, skeleton, "utf8");
  } catch (err) {
    // Ignore errors in debug logging
  }

  return skeleton;
}

export async function generateRepoMapForFile(workspacePath: string, absFilePath: string): Promise<string | null> {
  const IGNORE_DIRS = ["node_modules", "dist", ".rei", ".git", "bin"];
  if (IGNORE_DIRS.some((dir) => absFilePath.split(path.sep).includes(dir))) {
    return null;
  }

  const sections: string[] = [];
  const entryPointFiles = getEntryPointFiles(workspacePath);
  const relPath = path.relative(workspacePath, absFilePath).replace(/\\/g, "/");

  try {
    // 1. TS/JS (incluyendo tests para ts-morph, como en la generacion global)
    if (/\.(ts|js|tsx|jsx)$/.test(absFilePath)) {
      const project = new Project({
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true },
      });
      project.addSourceFileAtPath(absFilePath);
      const sourceFile = project.getSourceFile(absFilePath);
      if (sourceFile) {
        const section = renderSourceFile(workspacePath, sourceFile, entryPointFiles);
        if (section) sections.push(section);
      }
    }

    // 2. HTML
    if (absFilePath.endsWith(".html")) {
      const content = fs.readFileSync(absFilePath, "utf8");
      const tags = Array.from(content.matchAll(/<([a-zA-Z0-9\-]+)/g))
        .map((m) => m[1])
        .filter(
          (tag) =>
            tag.includes("-") ||
            !["div", "span", "p", "b", "i", "tr", "td", "table", "form", "input"].includes(tag.toLowerCase())
        );
      sections.push(`// FILE: ${relPath}\nRelevant Tags: ${[...new Set(tags)].join(", ")}`);
    }

    // 3. CSS/SCSS
    if (absFilePath.endsWith(".css") || absFilePath.endsWith(".scss")) {
      const content = fs.readFileSync(absFilePath, "utf8");
      const classes = Array.from(content.matchAll(/\.(\w[\w-]*)/g)).map((m) => m[1]);
      const ids = Array.from(content.matchAll(/#(\w[\w-]*)/g)).map((m) => m[1]);
      sections.push(`// FILE: ${relPath}\nCSS classes: ${[...new Set(classes)].join(", ")}\nCSS ids: ${[...new Set(ids)].join(", ")}`);
    }

    // 4. TESTS (regex approach)
    if (/\.(spec|test)\.(ts|js|tsx|jsx)$/.test(absFilePath)) {
      const content = fs.readFileSync(absFilePath, "utf8");
      const describes = Array.from(content.matchAll(/describe\s*\(\s*['"`]([^'"]+)['"`]/g)).map((m) => m[1]);
      const its = Array.from(content.matchAll(/(?:it|test)\s*\(\s*['"`]([^'"]+)['"`]/g)).map((m) => m[1]);
      sections.push(`// FILE: ${relPath}\nTest suites: ${[...new Set(describes)].join(", ")}\nTest cases: ${[...new Set(its)].join(", ")}`);
    }

    // 5. Polyglot (C, C++, C#, Python, Rust, Go) — AstProviderFactory / Tree-sitter
    if (/\.(py|c|h|cpp|hpp|cc|cxx|cs|rs|go)$/.test(absFilePath)) {
      const content = fs.readFileSync(absFilePath, "utf8");
      const ext = path.extname(absFilePath).toLowerCase();
      const languageId = getLanguageCapabilityForExtension(ext).id;
      const fileLike: SourceFileLike = {
        filePath: relPath,
        absoluteFilePath: absFilePath,
        languageId,
        content,
      };
      const provider = AstProviderFactory.resolve(fileLike);
      let chunks: AstChunk[] = [];
      try {
        chunks = await provider.extractChunks(fileLike);
      } catch { /* Tree-sitter failed; heuristic fallback below */ }
      if (chunks.length === 0) {
        // FR-8: heuristic fallback when Tree-sitter fails or returns no symbols
        try { chunks = await new HeuristicAstProvider().extractChunks(fileLike); } catch { /* skip */ }
      }
      if (chunks.length > 0) {
        const lines = chunks.map(
          (c) => `[${c.providerId}] ${c.nodeType} "${c.symbolName ?? "?"}" (L${c.startLine}-${c.endLine})`,
        );
        sections.push(`// FILE: ${relPath}\n${lines.join("\n")}`);
      } else {
        sections.push(`// FILE: ${relPath}`);
      }
    }
  } catch (err) {
    console.error(`[RepoMapGenerator] Error parsing ${absFilePath}:`, err);
    return null;
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

function renderSourceFile(
  workspacePath: string,
  sourceFile: SourceFile,
  entryPointFiles: Set<string>,
): string {
  const fileLines: string[] = [];

  const importsLine = renderImports(sourceFile);
  if (importsLine) {
    fileLines.push(importsLine);
  }

  for (const iface of sourceFile.getInterfaces()) {
    fileLines.push(renderInterface(iface));
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    fileLines.push(renderTypeAlias(typeAlias));
  }

  for (const cls of sourceFile.getClasses()) {
    fileLines.push(renderClass(cls));
  }

  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    fileLines.push(renderFunction(fn));
  }

  const compactLines = fileLines.filter(Boolean);
  if (compactLines.length === 0) {
    return "";
  }

  const absPath = sourceFile.getFilePath();
  const relPath = path.relative(workspacePath, absPath).replace(/\\/g, "/");
  const isEntry = entryPointFiles.has(absPath);
  const entryComment = isEntry ? "// ENTRY POINT" : "";
  return [`// FILE: ${relPath}`, entryComment, ...compactLines]
    .filter(Boolean)
    .join("\n");
}

function renderInterface(
  iface: import("ts-morph").InterfaceDeclaration,
): string {
  const isExported = iface.isExported();
  const exported = isExported ? "export " : "";
  const exportComment = isExported ? "// [exported]\n" : "";
  const extendsTypes = iface
    .getExtends()
    .map((e) => e.getText())
    .join(", ");
  const extendsClause = extendsTypes ? ` extends ${extendsTypes}` : "";
  const jsDoc = iface.getJsDocs()[0]?.getComment() || "";
  const jsDocLine = jsDoc ? `// ${jsDoc}\n` : "";
  const members = [
    ...iface.getProperties().map((prop) => renderPropertySignature(prop)),
    ...iface
      .getMethods()
      .map((method) => renderMethodSignatureWithJsDoc(method)),
  ].filter(Boolean);

  return `${exportComment}${jsDocLine}${exported}interface ${iface.getName()}${extendsClause} { ${members.join(" ")} }`;
}

function renderTypeAlias(typeAlias: TypeAliasDeclaration): string {
  const isExported = typeAlias.isExported();
  const exported = isExported ? "export " : "";
  const exportComment = isExported ? "// [exported]\n" : "";
  const typeNode = typeAlias.getTypeNode();

  if (typeNode?.getKind() === SyntaxKind.TypeLiteral) {
    const members = typeNode
      .getChildrenOfKind(SyntaxKind.PropertySignature)
      .map((prop) => renderPropertySignature(prop))
      .filter(Boolean);
    return `${exportComment}${exported}type ${typeAlias.getName()} = { ${members.join(" ")} };`;
  }

  return `${exportComment}${exported}type ${typeAlias.getName()} = ${typeNode?.getText() ?? "any"};`;
}

function renderClass(cls: import("ts-morph").ClassDeclaration): string {
  const isExported = cls.isExported();
  const exported = isExported ? "export " : "";
  const exportComment = isExported ? "// [exported]\n" : "";
  const className = cls.getName() ?? "AnonymousClass";
  const extendsType = cls.getExtends()?.getText() || "";
  const implementsTypes = cls
    .getImplements()
    .map((i) => i.getText())
    .join(", ");
  const extendsClause = extendsType ? ` extends ${extendsType}` : "";
  const implementsClause = implementsTypes
    ? ` implements ${implementsTypes}`
    : "";
  const jsDoc = cls.getJsDocs()[0]?.getComment() || "";
  const jsDocLine = jsDoc ? `// ${jsDoc}\n` : "";

  const props = cls
    .getProperties()
    .filter((prop) => (prop.getScope() ?? "public") === "public")
    .map((prop) => {
      const readonly = prop.isReadonly() ? "readonly " : "";
      const staticModifier = prop.isStatic() ? "static " : "";
      const optional = prop.hasQuestionToken() ? "?" : "";
      //const typeText = prop.getTypeNode()?.getText() ?? "any";
      const typeText = cleanTypeText(prop.getTypeNode()?.getText() ?? "any"); // <--- Limpieza aquí
      return `public ${staticModifier}${readonly}${prop.getName()}${optional}: ${typeText};`;
    });

  const methods = cls
    .getMethods()
    .filter((method) => (method.getScope() ?? "public") === "public")
    .map((method) => renderMethodSignatureWithJsDoc(method));

  return `${exportComment}${jsDocLine}${exported}class ${className}${extendsClause}${implementsClause} { ${[...props, ...methods].join(" ")} }`;
}

// Render method signature with JSDoc (for class and interface methods)
function renderMethodSignatureWithJsDoc(
  method:
    | import("ts-morph").MethodDeclaration
    | import("ts-morph").MethodSignature,
): string {
  const jsDoc = method.getJsDocs()[0]?.getComment() || "";
  const jsDocLine = jsDoc ? `// ${jsDoc}\n` : "";
  return (
    jsDocLine +
    renderMethodSignature({
      name: method.getName(),
      parameters: method
        .getParameters()
        .map((param) => `${param.getName()}: ${param.getType().getText()}`),
      returnType: method.getReturnType()?.getText() ?? "any",
      isAsync: "isAsync" in method && method.isAsync ? method.isAsync() : false,
      scope: "getScope" in method ? method.getScope?.() : undefined,
      isStatic: "isStatic" in method ? method.isStatic?.() : false,
    })
  );
}

function renderFunction(fn: import("ts-morph").FunctionDeclaration): string {
  const jsDoc = fn.getJsDocs()[0]?.getComment() || "";
  const jsDocLine = jsDoc ? `// ${jsDoc}\n` : "";
  const asyncPrefix = fn.isAsync() ? "async " : "";
  const name = fn.getName() ?? "anonymous";
  const parameters = fn
    .getParameters()
    .map((param) => `${param.getName()}: ${param.getType().getText()}`)
    .join(", ");
  const returnType = fn.getReturnType()?.getText() ?? "any";
  const exportComment = fn.isExported() ? "// [exported]\n" : "";
  return `${exportComment}${jsDocLine}export ${asyncPrefix}function ${name}(${parameters}): ${returnType};`;
}

function cleanTypeText(text: string): string {
  // Elimina patrones tipo import("/Users/.../file").Nombre por solo el Nombre
  return text.replace(/import\(".*?"\)\./g, "");
}

function renderPropertySignature(prop: PropertySignature): string {
  const optional = prop.hasQuestionToken() ? "?" : "";
  //const typeText = prop.getTypeNode()?.getText() ?? "any";
  const typeText = cleanTypeText(prop.getTypeNode()?.getText() ?? "any"); // <--- Limpieza aquí
  return `${prop.getName()}${optional}: ${typeText};`;
}

function renderMethodSignature(params: {
  name: string;
  parameters: string[];
  returnType: string;
  isAsync: boolean;
  scope?: string;
  isStatic?: boolean;
}): string {
  const scope = params.scope ? `${params.scope} ` : "";
  const asyncPrefix = params.isAsync ? "async " : "";
  const staticPrefix = params.isStatic ? "static " : "";
  return `${scope}${staticPrefix}${asyncPrefix}${params.name}(${params.parameters.join(", ")}): ${params.returnType};`;
}

function renderImports(sourceFile: SourceFile): string {
  const importDeclarations = sourceFile.getImportDeclarations();
  if (importDeclarations.length === 0) return "";

  const importPaths = importDeclarations.map((imp) => {
    const moduleSpecifier = imp.getModuleSpecifierValue();
    // Opcional: podrías filtrar solo imports locales (que empiecen con .)
    // si quieres que el agente se enfoque solo en el grafo del proyecto.
    return moduleSpecifier;
  });

  return `// Imports: ${[...new Set(importPaths)].join(", ")}`;
}
