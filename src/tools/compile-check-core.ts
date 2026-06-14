import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import { applyFileEdits } from "./search-replace.js";
import { detectProjectType } from "../workspace/project-type.js";

const execAsync = promisify(exec);

export interface VerifyCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AppliedSandboxEdits {
  virtualFiles: Map<string, string>;
  applyErrors: string[];
}

export interface GenericDiagnostic {
  filePath: string;
  line: number;
  column: number;
  message: string;
  code: string | number;
}

export interface GenericCompileCheckResult {
  success: boolean;
  diagnostics: GenericDiagnostic[];
  fileCount: number;
}

export interface GenericVirtualBatchResult {
  success: boolean;
  diagnostics: GenericDiagnostic[];
  applyErrors: string[];
  fileCount: number;
  virtualFiles: Map<string, string>;
  verifyCommand: string;
  verifyStdout: string;
  verifyStderr: string;
}

export interface CompileAdapter {
  canValidate(workspacePath: string): boolean;
  parseDiagnostics(workspacePath: string, output: string): GenericDiagnostic[];
  formatResult(result: GenericCompileCheckResult): string[];
  formatVirtualBatchResult(result: GenericVirtualBatchResult): string;
}

/**
 * Determines if a file/directory should be copied to the sandbox for validation.
 * Excludes directories that are locked by IDEs, contain build artifacts, or are unnecessary for compilation.
 *
 * Case-insensitive comparison is used because Windows filesystems are case-insensitive,
 * so .vs, .VS, .Vs all refer to the same Visual Studio directory that contains locked files.
 */
export function shouldCopyToSandbox(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (!normalized) return true;

  const parts = normalized.split("/");

  // Ignore binary/build folders and IDE specific lock/index files
  const ignoreDirs = [".git", "node_modules", ".vs", "obj", "bin"];

  if (parts.some(p => ignoreDirs.includes(p))) {
    return false;
  }

  return true;
}

export function resolveVerifyCommand(workspacePath: string): string {
  const detected = detectProjectType(workspacePath);
  return process.env.REI_SANDBOX_VERIFY_COMMAND ?? detected.verifyCommand;
}

export async function createSandboxWorkspace(workspacePath: string): Promise<string> {
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
    const symlinkType: fs.symlink.Type = process.platform === "win32" ? "junction" : "dir";
    try {
      await fs.promises.symlink(sourceNodeModules, sandboxNodeModules, symlinkType);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      const blocked = err.code === "EPERM" || err.code === "EACCES";
      if (!blocked) throw error;
      // Some Windows environments block symlink/junction creation; continue without failing sandbox creation.
    }
  }

  return sandboxRoot;
}

export async function removeSandboxWorkspace(sandboxPath: string): Promise<void> {
  await fs.promises.rm(sandboxPath, { recursive: true, force: true });
}

export async function withSandboxWorkspace<T>(
  workspacePath: string,
  runner: (sandboxPath: string) => Promise<T>,
): Promise<T> {
  const sandboxPath = await createSandboxWorkspace(workspacePath);
  try {
    return await runner(sandboxPath);
  } finally {
    await removeSandboxWorkspace(sandboxPath);
  }
}

export async function runVerifyCommand(
  cwd: string,
  command: string,
): Promise<VerifyCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 1024 * 1024 * 6,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });
    return { exitCode: 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } catch (error) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: stripAnsi(err.stdout ?? ""),
      stderr: stripAnsi(err.stderr ?? err.message ?? ""),
    };
  }
}

/**
 * Strips ANSI color/escape codes from compiler output. Some compilers (notably
 * Angular's ngc) ignore FORCE_COLOR=0 and still emit colors, which would clutter
 * the diagnostics fed back to the model.
 */
function stripAnsi(text: string | undefined): string {
  if (!text) return "";
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function groupEditsByFile(edits: AgentSREdit[]): Map<string, AgentSREdit[]> {
  const editsByFile = new Map<string, AgentSREdit[]>();

  for (const edit of edits) {
    if (!editsByFile.has(edit.file)) {
      editsByFile.set(edit.file, []);
    }

    editsByFile.get(edit.file)!.push(edit);
  }

  return editsByFile;
}

export async function applyEditsInWorkspace(
  workspacePath: string,
  editsByFile: Map<string, AgentSREdit[]>,
): Promise<AppliedSandboxEdits> {
  const virtualFiles = new Map<string, string>();
  const applyErrors: string[] = [];

  for (const [file, fileEdits] of editsByFile.entries()) {
    const targetFile = path.join(workspacePath, file);

    try {
      const text = await fs.promises.readFile(targetFile, "utf-8");
      const res = applyFileEdits(text, fileEdits);
      if (!res.success) {
        applyErrors.push(res.error!);
        continue;
      }

      await fs.promises.writeFile(targetFile, res.newContent!, "utf-8");
      virtualFiles.set(file, res.newContent!);
    } catch (err) {
      applyErrors.push(`Failed to read source file ${file}: ${err}`);
    }
  }

  return {
    virtualFiles,
    applyErrors,
  };
}

export async function applyEditsInSandbox(
  sandboxPath: string,
  edits: AgentSREdit[],
): Promise<AppliedSandboxEdits> {
  return applyEditsInWorkspace(sandboxPath, groupEditsByFile(edits));
}
