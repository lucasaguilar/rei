import * as path from "node:path";
import * as fs from "node:fs";
import { Project, ts } from "ts-morph";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { applyFileEdits } from "./search-replace.js";

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

export interface VirtualBatchResult {
  success: boolean;
  diagnostics: TypeScriptCompileDiagnostic[];
  applyErrors: string[];
  fileCount: number;
  virtualFiles: Map<string, string>;
}

export function extractUniqueDiagnostics(workspacePath: string, project: Project): TypeScriptCompileDiagnostic[] {
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

  return unique;
}

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

  const unique = extractUniqueDiagnostics(workspacePath, project);

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

/**
 * Applies a batch of Search & Replace edits IN-MEMORY to a ts-morph project
 * and retrieves any compilation errors caused by the edits.
 * Does not write to disk.
 */
export async function applyVirtualBatch(
  workspacePath: string,
  edits: AgentSREdit[]
): Promise<VirtualBatchResult> {
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const virtualFiles = new Map<string, string>();
  const applyErrors: string[] = [];

  // Group edits by file
  const editsByFile = new Map<string, AgentSREdit[]>();
  for (const edit of edits) {
    if (!editsByFile.has(edit.file)) editsByFile.set(edit.file, []);
    editsByFile.get(edit.file)!.push(edit);
  }

  if (!fs.existsSync(tsconfigPath)) {
    // If it's not a TS project, we just do textual S&R checks without compilation validation
    for (const [file, fileEdits] of editsByFile.entries()) {
      const absPath = path.join(workspacePath, file);
      try {
        const text = await fs.promises.readFile(absPath, "utf-8");
        const res = applyFileEdits(text, fileEdits);
        if (!res.success) {
          applyErrors.push(res.error!);
        } else {
          virtualFiles.set(file, res.newContent!);
        }
      } catch (err) {
        applyErrors.push(`Failed to read source file ${file}: ${err}`);
      }
    }
    
    return {
      success: applyErrors.length === 0,
      diagnostics: [],
      applyErrors,
      fileCount: 0,
      virtualFiles
    };
  }

  // TS Project validation
  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  // 1. Gather baseline diagnostics (pre-existing errors)
  const baselineDiagnostics = extractUniqueDiagnostics(workspacePath, project);
  const baselineKeys = new Set(
    baselineDiagnostics.map(d => `${d.filePath}:${d.code}:${d.message}`)
  );

  // 2. Apply mutations in-memory
  for (const [file, fileEdits] of editsByFile.entries()) {
    const absPath = path.join(workspacePath, file);
    const sourceFile = project.getSourceFile(absPath);
    
    if (!sourceFile) {
      // It might be a new file being created, or an untracked file
      applyErrors.push(`File ${file} not found in TS project context.`);
      continue;
    }

    const text = sourceFile.getFullText();
    const res = applyFileEdits(text, fileEdits);
    if (!res.success) {
      applyErrors.push(res.error!);
    } else {
      sourceFile.replaceWithText(res.newContent!);
      virtualFiles.set(file, res.newContent!);
    }
  }

  // If text application failed, no point compiling
  if (applyErrors.length > 0) {
    return {
      success: false,
      diagnostics: [],
      applyErrors,
      fileCount: project.getSourceFiles().length,
      virtualFiles
    };
  }

  // 3. Evaluate TS diagnostics on the mutated virtual project
  const currentDiagnostics = extractUniqueDiagnostics(workspacePath, project);

  // 4. Filter strictly for *new* diagnostics that didn't exist in the baseline
  const newDiagnostics = currentDiagnostics.filter(
    d => !baselineKeys.has(`${d.filePath}:${d.code}:${d.message}`)
  );

  return {
    success: newDiagnostics.length === 0,
    diagnostics: newDiagnostics.slice(0, 30),
    applyErrors: [],
    fileCount: project.getSourceFiles().length,
    virtualFiles
  };
}

export function formatVirtualBatchResult(result: VirtualBatchResult): string {
  const lines: string[] = [];
  
  if (result.applyErrors.length > 0) {
    lines.push("❌ Failed to apply patches:");
    for (const err of result.applyErrors) {
      lines.push(`  - ${err}`);
    }
    return lines.join("\n");
  }

  if (result.success) {
    return `✅ All patches applied and validated successfully (${result.fileCount} files checked).`;
  }

  lines.push(`❌ Validation failed with ${result.diagnostics.length} compilation error(s):`);
  for (const d of result.diagnostics) {
    lines.push(`  [${d.filePath}:${d.line}:${d.column}] TS${d.code}: ${d.message}`);
  }
  return lines.join("\n");
}
