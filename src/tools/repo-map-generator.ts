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

const REPO_MAP_HEADER = "### REPOSITORY SKELETON MAP";

export function generateRepoMap(workspacePath: string): string {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
    skipAddingFilesFromTsConfig: false,
    compilerOptions: {
      allowJs: true,
    },
  });

  const sourceFiles = project
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile())
    .filter(
      (sourceFile) => !sourceFile.getFilePath().includes("/node_modules/"),
    )
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));

  const sections: string[] = [];

  for (const sourceFile of sourceFiles) {
    const section = renderSourceFile(workspacePath, sourceFile);
    if (section) {
      sections.push(section);
    }
  }

  return sections.length > 0
    ? `${REPO_MAP_HEADER}\n\n${sections.join("\n\n")}`
    : `${REPO_MAP_HEADER}\n\n(No TypeScript declarations found.)`;
}

function renderSourceFile(
  workspacePath: string,
  sourceFile: SourceFile,
): string {
  const fileLines: string[] = [];

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

  const relPath = path
    .relative(workspacePath, sourceFile.getFilePath())
    .replace(/\\/g, "/");
  return [`// FILE: ${relPath}`, ...compactLines].join("\n");
}

function renderInterface(
  iface: import("ts-morph").InterfaceDeclaration,
): string {
  const exported = iface.isExported() ? "export " : "";
  const members = [
    ...iface.getProperties().map((prop) => renderPropertySignature(prop)),
    ...iface.getMethods().map((method) =>
      renderMethodSignature({
        name: method.getName(),
        parameters: method.getParameters().map((param) => param.getText()),
        returnType: method.getReturnTypeNode()?.getText() ?? "any",
        isAsync: false,
        scope: undefined,
      }),
    ),
  ].filter(Boolean);

  return `${exported}interface ${iface.getName()} { ${members.join(" ")} }`;
}

function renderTypeAlias(typeAlias: TypeAliasDeclaration): string {
  const exported = typeAlias.isExported() ? "export " : "";
  const typeNode = typeAlias.getTypeNode();

  if (typeNode?.getKind() === SyntaxKind.TypeLiteral) {
    const members = typeNode
      .getChildrenOfKind(SyntaxKind.PropertySignature)
      .map((prop) => renderPropertySignature(prop))
      .filter(Boolean);
    return `${exported}type ${typeAlias.getName()} = { ${members.join(" ")} };`;
  }

  return `${exported}type ${typeAlias.getName()} = ${typeNode?.getText() ?? "any"};`;
}

function renderClass(cls: import("ts-morph").ClassDeclaration): string {
  const exported = cls.isExported() ? "export " : "";
  const className = cls.getName() ?? "AnonymousClass";
  const props = cls
    .getProperties()
    .filter((prop) => (prop.getScope() ?? "public") === "public")
    .map((prop) => {
      const readonly = prop.isReadonly() ? "readonly " : "";
      const staticModifier = prop.isStatic() ? "static " : "";
      const optional = prop.hasQuestionToken() ? "?" : "";
      const typeText = prop.getTypeNode()?.getText() ?? "any";
      return `public ${staticModifier}${readonly}${prop.getName()}${optional}: ${typeText};`;
    });
  const methods = cls
    .getMethods()
    .filter((method) => (method.getScope() ?? "public") === "public")
    .map((method) =>
      renderMethodSignature({
        name: method.getName(),
        parameters: method.getParameters().map((param) => param.getText()),
        returnType: method.getReturnTypeNode()?.getText() ?? "any",
        isAsync: method.isAsync(),
        scope: "public",
        isStatic: method.isStatic(),
      }),
    );

  return `${exported}class ${className} { ${[...props, ...methods].join(" ")} }`;
}

function renderFunction(fn: import("ts-morph").FunctionDeclaration): string {
  const asyncPrefix = fn.isAsync() ? "async " : "";
  const name = fn.getName() ?? "anonymous";
  const parameters = fn
    .getParameters()
    .map((param) => param.getText())
    .join(", ");
  const returnType = fn.getReturnTypeNode()?.getText() ?? "any";
  return `export ${asyncPrefix}function ${name}(${parameters}): ${returnType};`;
}

function renderPropertySignature(prop: PropertySignature): string {
  const optional = prop.hasQuestionToken() ? "?" : "";
  const typeText = prop.getTypeNode()?.getText() ?? "any";
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
