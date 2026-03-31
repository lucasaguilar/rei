import { Project, SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

export interface AstContextResult {
  text: string;
  filesScraped: number;
  dependenciesFound: number;
}

export async function extractAstDependencies(
  workspacePath: string,
  filePaths: string[]
): Promise<AstContextResult> {
  // If no files to check, return empty
  if (filePaths.length === 0) {
    return { text: "", filesScraped: 0, dependenciesFound: 0 };
  }

  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsconfigPath) ? tsconfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
    },
  });

  const scrapedDependencies = new Set<string>();
  const outputLines: string[] = [];

  for (const relPath of filePaths) {
    const ext = relPath.split(".").pop()?.toLowerCase();
    if (ext !== "ts" && ext !== "tsx" && ext !== "js" && ext !== "jsx") continue;

    const absPath = path.resolve(workspacePath, relPath);
    if (!fs.existsSync(absPath)) continue;

    const sourceFile = project.addSourceFileAtPath(absPath);

    // Get all imports in this file
    const imports = sourceFile.getImportDeclarations();
    for (const imp of imports) {
      const moduleSourceFile = imp.getModuleSpecifierSourceFile();
      if (!moduleSourceFile) continue; // Unresolvable or built-in Node type

      const modulePath = moduleSourceFile.getFilePath();
      
      // We only care about local workspace dependencies, skip third-party
      if (modulePath.includes("node_modules")) continue;
      
      // Avoid circular or duplicate generation
      if (scrapedDependencies.has(modulePath)) continue;
      scrapedDependencies.add(modulePath);

      const relDependencyPath = path.relative(workspacePath, modulePath);
      outputLines.push(`\n// [AST Dependency Skeleton] -> ${relDependencyPath}`);
      outputLines.push(extractSignatures(moduleSourceFile));
    }
  }

  return {
    text: outputLines.join("\n"),
    filesScraped: filePaths.length,
    dependenciesFound: scrapedDependencies.size,
  };
}

/**
 * Parses the raw AST of a TS Module and extracts a clean, body-less representation 
 * of exported Classes, Interfaces, Types, and Functions. (Simulates .d.ts extremely fast).
 */
function extractSignatures(sourceFile: SourceFile): string {
  const lines: string[] = [];

  // Scrape Classes
  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue;
    const className = cls.getName() || "AnonymousClass";
    
    // Get class properties (like variables, signals)
    const props = cls.getProperties().map(p => {
        const modifier = p.getScope() !== "public" ? p.getScope() + " " : "";
        const readonly = p.isReadonly() ? "readonly " : "";
        return `  ${modifier}${readonly}${p.getName()}: ${p.getTypeNode()?.getText() || "any"};`;
    });
    
    // Get signatures for methods
    const methods = cls.getMethods().map(m => {
        const modifier = m.getScope() !== "public" ? m.getScope() + " " : "";
        const params = m.getParameters().map(param => param.getText()).join(", ");
        return `  ${modifier}${m.getName()}(${params}): ${m.getReturnTypeNode()?.getText() || "any"};`;
    });

    lines.push(`export class ${className} {`);
    if (props.length > 0) lines.push(...props);
    if (methods.length > 0) lines.push(...methods);
    lines.push(`}`);
  }

  // Scrape Interfaces
  for (const iface of sourceFile.getInterfaces()) {
    if (!iface.isExported()) continue;
    const ifaceName = iface.getName();
    
    const props = iface.getProperties().map(p => {
        const opt = p.hasQuestionToken() ? "?" : "";
        return `  ${p.getName()}${opt}: ${p.getTypeNode()?.getText() || "any"};`;
    });
    
    const methods = iface.getMethods().map(m => {
        const params = m.getParameters().map(param => param.getText()).join(", ");
        return `  ${m.getName()}(${params}): ${m.getReturnTypeNode()?.getText() || "any"};`;
    });

    lines.push(`export interface ${ifaceName} {`);
    if (props.length > 0) lines.push(...props);
    if (methods.length > 0) lines.push(...methods);
    lines.push(`}`);
  }

  // Scrape Types
  for (const t of sourceFile.getTypeAliases()) {
    if (!t.isExported()) continue;
    lines.push(`export type ${t.getName()} = ${t.getTypeNode()?.getText() || "any"};`);
  }

  // Scrape Functions
  for (const func of sourceFile.getFunctions()) {
    if (!func.isExported()) continue;
    const name = func.getName() || "anonymous";
    const params = func.getParameters().map(p => p.getText()).join(", ");
    const retType = func.getReturnTypeNode()?.getText() || "any";
    lines.push(`export function ${name}(${params}): ${retType};`);
  }

  // Variable Statements (Exported constants, Stores, etc.)
  for (const vs of sourceFile.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const vd of vs.getDeclarations()) {
      lines.push(`export const ${vd.getName()}: ${vd.getTypeNode()?.getText() || "any"};`);
    }
  }

  return lines.join("\n");
}
