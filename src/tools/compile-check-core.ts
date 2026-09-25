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
  /** Whether the command actually RAN. A `success` with this false is an absence of verification,
   *  not a pass — the two used to be indistinguishable. */
  verifyRan: boolean;
  verifyStdout: string;
  verifyStderr: string;
}

export interface CompileAdapter {
  canValidate(workspacePath: string): boolean;
  parseDiagnostics(workspacePath: string, output: string): GenericDiagnostic[];
  formatResult(result: GenericCompileCheckResult): string[];
  formatVirtualBatchResult(result: GenericVirtualBatchResult): string;
  /**
   * Given compile diagnostics, return workspace-relative paths of OTHER files the model
   * likely needs to edit too — derived from each language's "missing symbol / missing module"
   * errors (e.g. a consumer importing a not-yet-added export names its provider module in the
   * error text). Lets the agent loop inject those files so the model fixes all interdependent
   * files in ONE batch instead of looping one file at a time.
   *
   * Returns [] when the language can't map errors to editable files. The generic
   * d.filePath-based fallback (files where errors APPEAR) is language-agnostic and handled
   * by the caller — this method only adds the language-specific REFERENCED-module cases.
   */
  resolveReferencedFiles(
    workspacePath: string,
    diagnostics: GenericDiagnostic[],
  ): string[];
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

  // Ignore binary/build folders and IDE specific lock/index files.
  // `.ai` is a symlink to a shared config dir OUTSIDE the repo (e.g. ~/www/.ai); fs.cp with
  // recursive:true would otherwise copy the symlink into the sandbox, and tsc could then follow
  // it into a foreign project with its own tsconfig and node_modules.
  const ignoreDirs = [".git", "node_modules", ".vs", "obj", "bin", ".ai"];

  if (parts.some(p => ignoreDirs.includes(p))) {
    return false;
  }

  return true;
}

export function resolveVerifyCommand(workspacePath: string): string {
  const detected = detectProjectType(workspacePath);
  return process.env.REI_SANDBOX_VERIFY_COMMAND ?? detected.verifyCommand;
}

/**
 * The placeholder a project with no known checker gets. `echo ok` cannot fail, which is the point:
 * it is a NO-OP, never a verdict. Anything that treats its exit code as verification is lying.
 */
export const NO_VERIFY_COMMAND = "echo ok";

/**
 * Whether a verify run means "the tool is not here" rather than "the code is wrong".
 *
 * A shell reports a missing binary as exit 127 plus "command not found"; reporting that as a failing
 * type-check is the same lie as the silent green it replaced, pointing the other way — it did not
 * run. The caller turns this into `verifyRan: false` and says which command was missing.
 */
export function verifyToolMissing(exitCode: number, output: string): boolean {
  return (
    exitCode === 127 ||
    /command not found|: not found|is not recognized as an internal/i.test(output)
  );
}

/**
 * Whether this workspace has a check worth running. It is the gate on the whole verify step, so the
 * question has to be "is there a real command?" and not "is this TypeScript?" — that mistake limited
 * REI's central promise to two languages while reporting green for the rest.
 */
export function hasRealVerifyCommand(workspacePath: string): boolean {
  const command = resolveVerifyCommand(workspacePath).trim();
  return command.length > 0 && command !== NO_VERIFY_COMMAND;
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
