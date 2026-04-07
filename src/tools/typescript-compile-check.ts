import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { applyFileEdits } from "./search-replace.js";

const execAsync = promisify(exec);

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
  verifyCommand: string;
  verifyStdout: string;
  verifyStderr: string;
}

const DEFAULT_VERIFY_COMMAND = "npx tsc --noEmit --pretty false";

function shouldCopyToSandbox(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized) return true;

  const root = normalized.split("/")[0];
  if (root === ".git" || root === "node_modules") {
    return false;
  }

  return true;
}

async function createSandboxWorkspace(workspacePath: string): Promise<string> {
  const sandboxRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "rei-sandbox-"),
  );

  await fs.promises.cp(workspacePath, sandboxRoot, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(workspacePath, src);
      return shouldCopyToSandbox(rel);
    },
  });

  const sourceNodeModules = path.join(workspacePath, "node_modules");
  const sandboxNodeModules = path.join(sandboxRoot, "node_modules");
  if (fs.existsSync(sourceNodeModules) && !fs.existsSync(sandboxNodeModules)) {
    await fs.promises.symlink(sourceNodeModules, sandboxNodeModules, "dir");
  }

  return sandboxRoot;
}

async function runVerifyCommand(
  cwd: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 1024 * 1024 * 6,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
}

function parseTscDiagnostics(
  workspacePath: string,
  output: string,
): TypeScriptCompileDiagnostic[] {
  const diagnostics: TypeScriptCompileDiagnostic[] = [];
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

export async function runTypeScriptCompileCheck(
  workspacePath: string,
): Promise<TypeScriptCompileCheckResult> {
  if (!fs.existsSync(path.join(workspacePath, "tsconfig.json"))) {
    return { success: true, diagnostics: [], fileCount: 0 };
  }

  const command =
    process.env.REI_SANDBOX_VERIFY_COMMAND ?? DEFAULT_VERIFY_COMMAND;
  const verify = await runVerifyCommand(workspacePath, command);
  const diagnostics = parseTscDiagnostics(
    workspacePath,
    `${verify.stdout}\n${verify.stderr}`,
  );

  return {
    success: verify.exitCode === 0,
    diagnostics: diagnostics.slice(0, 30),
    fileCount: 0,
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
  edits: AgentSREdit[],
): Promise<VirtualBatchResult> {
  const virtualFiles = new Map<string, string>();
  const applyErrors: string[] = [];
  const command =
    process.env.REI_SANDBOX_VERIFY_COMMAND ?? DEFAULT_VERIFY_COMMAND;

  // Group edits by file
  const editsByFile = new Map<string, AgentSREdit[]>();
  for (const edit of edits) {
    if (!editsByFile.has(edit.file)) editsByFile.set(edit.file, []);
    editsByFile.get(edit.file)!.push(edit);
  }

  if (!fs.existsSync(path.join(workspacePath, "tsconfig.json"))) {
    return {
      success: applyErrors.length === 0,
      diagnostics: [],
      applyErrors,
      fileCount: 0,
      virtualFiles,
      verifyCommand: command,
      verifyStdout: "",
      verifyStderr: "",
    };
  }

  const sandboxPath = await createSandboxWorkspace(workspacePath);

  try {
    for (const [file, fileEdits] of editsByFile.entries()) {
      const sandboxFile = path.join(sandboxPath, file);

      try {
        const text = await fs.promises.readFile(sandboxFile, "utf-8");
        const res = applyFileEdits(text, fileEdits);
        if (!res.success) {
          applyErrors.push(res.error!);
          continue;
        }

        await fs.promises.writeFile(sandboxFile, res.newContent!, "utf-8");
        virtualFiles.set(file, res.newContent!);
      } catch (err) {
        applyErrors.push(`Failed to read source file ${file}: ${err}`);
      }
    }

    if (applyErrors.length > 0) {
      return {
        success: false,
        diagnostics: [],
        applyErrors,
        fileCount: 0,
        virtualFiles,
        verifyCommand: command,
        verifyStdout: "",
        verifyStderr: "",
      };
    }

    const verify = await runVerifyCommand(sandboxPath, command);
    const output = `${verify.stdout}\n${verify.stderr}`;
    const diagnostics = parseTscDiagnostics(workspacePath, output).slice(0, 30);

    return {
      success: verify.exitCode === 0,
      diagnostics,
      applyErrors: [],
      fileCount: 0,
      virtualFiles,
      verifyCommand: command,
      verifyStdout: verify.stdout,
      verifyStderr: verify.stderr,
    };
  } finally {
    await fs.promises.rm(sandboxPath, { recursive: true, force: true });
  }
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
    return `✅ All patches applied and validated successfully with sandbox command: ${result.verifyCommand}`;
  }

  lines.push(
    `❌ Validation failed with ${result.diagnostics.length} compilation error(s).`,
  );
  lines.push(`Command: ${result.verifyCommand}`);
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

  return lines.join("\n");
}
