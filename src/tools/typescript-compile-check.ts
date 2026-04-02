import * as path from "node:path";
import * as fs from "node:fs";
import { Project, ts } from "ts-morph";

export interface TypeScriptCompileDiagnostic {
  filePath: string;
  line: number;
  column: number;
  message: string;
  code: number;
}

export interface TypeScriptCompileCheckResult {
  success: boolean;
  diagnostics: TypeScriptCompileDiagnostic[];
  fileCount: number;
}

/**
 * Tier 1 semantic validation for TypeScript/JavaScript workspaces.
 *
 * This check is intentionally TypeScript-specific: it uses ts-morph and the
 * TypeScript compiler API, and it only runs when a tsconfig.json is present.
 * Other languages currently degrade to text-level workflows and git-level
 * patch validation only.
 */
export async function runTypeScriptCompileCheck(
  workspacePath: string,
): Promise<TypeScriptCompileCheckResult> {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    return { success: true, diagnostics: [], fileCount: 0 };
  }

  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  const allDiagnostics = project.getPreEmitDiagnostics();
  const diagnostics: TypeScriptCompileDiagnostic[] = [];

  for (const d of allDiagnostics) {
    const sourceFile = d.getSourceFile();
    const start = d.getStart();

    if (!sourceFile || start == null) continue;

    const { line, column } = sourceFile.getLineAndColumnAtPos(start);
    const absPath = sourceFile.getFilePath();
    const relPath = path.relative(workspacePath, absPath).replace(/\\/g, "/");

    if (relPath.startsWith("node_modules") || relPath.startsWith(".."))
      continue;

    diagnostics.push({
      filePath: relPath,
      line,
      column,
      message: ts.flattenDiagnosticMessageText(
        d.compilerObject.messageText,
        "\n",
      ),
      code: d.getCode(),
    });
  }

  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.filePath}:${d.line}:${d.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    success: unique.length === 0,
    diagnostics: unique.slice(0, 30),
    fileCount: project.getSourceFiles().length,
  };
}

export function formatTypeScriptCompileResult(
  result: TypeScriptCompileCheckResult,
): string[] {
  if (result.success) {
    return [
      `[tsc] ✓ No type errors found (${result.fileCount} files checked).`,
    ];
  }

  const lines: string[] = [
    `[tsc] ✗ ${result.diagnostics.length} error(s) found — fix before committing:`,
  ];

  for (const d of result.diagnostics) {
    lines.push(
      `  ${d.filePath}:${d.line}:${d.column}  TS${d.code}: ${d.message}`,
    );
  }

  if (result.diagnostics.length === 30) {
    lines.push(`  ... (output capped at 30 errors)`);
  }

  return lines;
}
