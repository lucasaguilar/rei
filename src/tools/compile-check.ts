import * as path from 'node:path';
import * as fs from 'node:fs';
import { Project, ts } from 'ts-morph';

export interface CompileDiagnostic {
  filePath: string;
  line: number;
  column: number;
  message: string;
  code: number;
}

export interface CompileCheckResult {
  success: boolean;
  diagnostics: CompileDiagnostic[];
  fileCount: number;
}

/**
 * Runs a full TypeScript compilation check on the workspace using the
 * TypeScript API directly (no child_process / shell required).
 * Returns all type errors found across the project.
 */
export async function runCompileCheck(workspacePath: string): Promise<CompileCheckResult> {
  const tsconfigPath = path.join(workspacePath, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    return { success: true, diagnostics: [], fileCount: 0 };
  }

  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  const allDiagnostics = project.getPreEmitDiagnostics();
  const diagnostics: CompileDiagnostic[] = [];

  for (const d of allDiagnostics) {
    const sourceFile = d.getSourceFile();
    const start = d.getStart();

    if (!sourceFile || start == null) continue;

    const { line, column } = sourceFile.getLineAndColumnAtPos(start);
    const absPath = sourceFile.getFilePath();
    const relPath = path.relative(workspacePath, absPath).replace(/\\/g, '/');

    // NOTE: Skip node_modules and generated declaration files
    if (relPath.startsWith('node_modules') || relPath.startsWith('..')) continue;

    diagnostics.push({
      filePath: relPath,
      line,
      column,
      message: ts.flattenDiagnosticMessageText(d.compilerObject.messageText, '\n'),
      code: d.getCode(),
    });
  }

  // Deduplicate by file+line+code (ts-morph can emit the same diagnostic twice)
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.filePath}:${d.line}:${d.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    success: unique.length === 0,
    diagnostics: unique.slice(0, 30), // cap to avoid overloading the terminal
    fileCount: project.getSourceFiles().length,
  };
}

/**
 * Formats compile diagnostics into lines ready for pushTranscript.
 */
export function formatCompileResult(result: CompileCheckResult): string[] {
  if (result.success) {
    return [`[tsc] ✓ No type errors found (${result.fileCount} files checked).`];
  }

  const lines: string[] = [
    `[tsc] ✗ ${result.diagnostics.length} error(s) found — fix before committing:`,
  ];

  for (const d of result.diagnostics) {
    lines.push(`  ${d.filePath}:${d.line}:${d.column}  TS${d.code}: ${d.message}`);
  }

  if (result.diagnostics.length === 30) {
    lines.push(`  ... (output capped at 30 errors)`);
  }

  return lines;
}
