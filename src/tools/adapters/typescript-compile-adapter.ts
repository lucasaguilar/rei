import * as path from "node:path";
import * as fs from "node:fs";

import type { CompileAdapter, GenericDiagnostic, GenericCompileCheckResult, GenericVirtualBatchResult } from "../compile-check-core.js";

export class TypeScriptCompileAdapter implements CompileAdapter {
  canValidate(workspacePath: string): boolean {
    return fs.existsSync(path.join(workspacePath, "tsconfig.json"));
  }

  parseDiagnostics(workspacePath: string, output: string): GenericDiagnostic[] {
    const diagnostics: GenericDiagnostic[] = [];
    const lines = output.split("\n");

    for (const line of lines) {
      const match = line.match(/^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
      if (!match) continue;

      const rawPath = match[1].trim();
      const lineNum = Number(match[2]);
      const colNum = Number(match[3]);
      const code = Number(match[4]);
      const message = match[5].trim();

      const absPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.join(workspacePath, rawPath);
      const relPath = path.relative(workspacePath, absPath).replace(/\\/g, "/");

      diagnostics.push({
        filePath: relPath,
        line: Number.isFinite(lineNum) ? lineNum : 0,
        column: Number.isFinite(colNum) ? colNum : 0,
        code: Number.isFinite(code) ? code : 0,
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

  resolveReferencedFiles(
    workspacePath: string,
    diagnostics: GenericDiagnostic[],
  ): string[] {
    // TS error codes whose message names an importable module specifier (the provider side
    // of a consumer→provider edit): 2305/2614/2724 "Module 'X' has no exported member 'Y'",
    // 2307 "Cannot find module 'X'".
    const MODULE_REF_CODES = new Set([2305, 2307, 2614, 2724]);
    const found = new Set<string>();
    for (const d of diagnostics) {
      const code = typeof d.code === "string" ? parseInt(d.code, 10) : d.code;
      if (!Number.isNaN(code) && !MODULE_REF_CODES.has(code)) continue;
      // First quoted RELATIVE specifier in the message (handles TS's nested quoting, e.g. '"./x"').
      const spec = d.message.match(/['"]+(\.[^'"\s]+?)['"]+/)?.[1];
      if (!spec) continue;
      const fromDir = path.dirname(path.resolve(workspacePath, d.filePath));
      const base = path.resolve(fromDir, spec);
      // Import specifiers use `.js`/no extension; the real source is `.ts`/`.tsx` (or an index file).
      const candidates = [
        `${base}.ts`,
        `${base}.tsx`,
        base.replace(/\.jsx?$/, ".ts"),
        base.replace(/\.jsx?$/, ".tsx"),
        path.join(base, "index.ts"),
        path.join(base, "index.tsx"),
      ];
      const hit = candidates.find((p) => fs.existsSync(p));
      if (hit) found.add(path.relative(workspacePath, hit).replace(/\\/g, "/"));
    }
    return [...found];
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
        `  [${d.filePath}:${d.line}:${d.column}] TS${d.code}: ${d.message}`,
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