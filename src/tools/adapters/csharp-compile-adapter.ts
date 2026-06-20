import * as path from "node:path";
import * as fs from "node:fs";

import type { CompileAdapter, GenericDiagnostic, GenericCompileCheckResult, GenericVirtualBatchResult } from "../compile-check-core.js";

export class CSharpCompileAdapter implements CompileAdapter {
  canValidate(workspacePath: string): boolean {
    // Check for .csproj or .sln files
    const files = fs.readdirSync(workspacePath);
    return files.some(file => file.endsWith('.csproj') || file.endsWith('.sln'));
  }

  parseDiagnostics(workspacePath: string, output: string): GenericDiagnostic[] {
    const diagnostics: GenericDiagnostic[] = [];
    const lines = output.split("\n");

    // CSC/Roslyn error format: file.cs(line,col): error CS123: message
    for (const line of lines) {
      const match = line.match(/^(.*)\((\d+),(\d+)\): error (CS\d+): (.*)$/);
      if (!match) continue;

      const rawPath = match[1].trim();
      const lineNum = Number(match[2]);
      const colNum = Number(match[3]);
      const code = match[4];
      const message = match[5].trim();

      const absPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.join(workspacePath, rawPath);
      const relPath = path.relative(workspacePath, absPath).replace(/\\/g, "/");

      diagnostics.push({
        filePath: relPath,
        line: Number.isFinite(lineNum) ? lineNum : 0,
        column: Number.isFinite(colNum) ? colNum : 0,
        code,
        message,
      });
    }

    const seen = new Set<string>();
    return diagnostics.filter((d) => {
      const key = `${d.filePath}:${d.line}:${d.code}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  formatResult(result: GenericCompileCheckResult): string[] {
    if (result.success) {
      return [
        `[csc] ✓ No compilation errors found (${result.fileCount} files checked).`,
      ];
    }

    const lines: string[] = [
      `[csc] ✗ ${result.diagnostics.length} error(s) found — fix before committing:`,
    ];

    for (const d of result.diagnostics) {
      lines.push(
        `  ${d.filePath}:${d.line}:${d.column}  ${d.code}: ${d.message}`,
      );
    }

    if (result.diagnostics.length === 30) {
      lines.push(`  ... (output capped at 30 errors)`);
    }

    return lines;
  }

  resolveReferencedFiles(
    _workspacePath: string,
    _diagnostics: GenericDiagnostic[],
  ): string[] {
    // C# resolves symbols via namespaces (not relative file imports), so a "missing
    // type/namespace" error (CS0246/CS0103) doesn't name an editable file path the way a
    // TS "Cannot find module './x'" does. The caller's generic d.filePath fallback still
    // applies. Implement namespace→file mapping here if C# cross-file edit loops appear.
    return [];
  }

  formatVirtualBatchResult(result: GenericVirtualBatchResult): string {
    const lines: string[] = [];

    if (result.applyErrors.length > 0) {
      lines.push("❌ Failed to apply patches:");
      for (const err of result.applyErrors) {
        lines.push(`  - ${err}`);
      }
      return lines.join("\n");
    }

    if (result.success) {
      return `✅ All patches applied and validated successfully with sandbox command: \`${result.verifyCommand}\``;
    }

    lines.push(
      `❌ Validation failed with ${result.diagnostics.length} compilation error(s).`,
    );
    for (const d of result.diagnostics) {
      lines.push(
        `  [${d.filePath}:${d.line}:${d.column}] ${d.code}: ${d.message}`,
      );
    }

    const stderrPreview = result.verifyStderr.trim();
    if (stderrPreview) {
      lines.push("\nCompiler stderr preview:");
      lines.push(stderrPreview.split("\n").slice(0, 20).join("\n"));
    }

    const stdoutPreview = result.verifyStdout.trim();
    if (stdoutPreview) {
      lines.push("\nCompiler stdout preview:");
      lines.push(stdoutPreview.split("\n").slice(0, 20).join("\n"));
    }

    lines.push(`\nRun: \`${result.verifyCommand}\``);
    return lines.join("\n");
  }
}