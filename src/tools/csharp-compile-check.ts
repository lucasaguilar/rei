import * as path from "node:path";
import * as fs from "node:fs";

import type { AgentSREdit } from "../contracts/agent-interaction.types.js";
import {
  applyEditsInSandbox,
  resolveVerifyCommand,
  runVerifyCommand,
  withSandboxWorkspace,
  type GenericCompileCheckResult,
  type GenericVirtualBatchResult,
} from "./compile-check-core.js";
import { CSharpCompileAdapter } from "./adapters/csharp-compile-adapter.js";

export { shouldCopyToSandbox } from "./compile-check-core.js";

const adapter = new CSharpCompileAdapter();

export function parseCscDiagnostics(
  workspacePath: string,
  output: string,
): CSharpCompileDiagnostic[] {
  return adapter.parseDiagnostics(workspacePath, output) as CSharpCompileDiagnostic[];
}

export interface CSharpCompileDiagnostic {
  filePath: string;
  line: number;
  column: number;
  message: string;
  code: string;
}

export interface CSharpCompileCheckResult {
  success: boolean;
  diagnostics: CSharpCompileDiagnostic[];
  fileCount: number;
}

export interface VirtualBatchResult {
  success: boolean;
  diagnostics: CSharpCompileDiagnostic[];
  applyErrors: string[];
  fileCount: number;
  virtualFiles: Map<string, string>;
  verifyCommand: string;
  verifyStdout: string;
  verifyStderr: string;
}

export async function runCSharpCompileCheck(
  workspacePath: string,
): Promise<CSharpCompileCheckResult> {
  if (!adapter.canValidate(workspacePath)) {
    return { success: true, diagnostics: [], fileCount: 0 };
  }

  const command = resolveVerifyCommand(workspacePath);
  const verify = await runVerifyCommand(workspacePath, command);
  const diagnostics = adapter.parseDiagnostics(
    workspacePath,
    `${verify.stdout}\n${verify.stderr}`,
  ) as CSharpCompileDiagnostic[];

  return {
    success: verify.exitCode === 0,
    diagnostics: diagnostics.slice(0, 30),
    fileCount: 0,
  };
}

export function formatCSharpCompileResult(
  result: CSharpCompileCheckResult,
): string[] {
  return adapter.formatResult(result as GenericCompileCheckResult);
}

/**
 * Applies a batch of Search & Replace edits IN-MEMORY to a C# project
 * and retrieves any compilation errors caused by the edits.
 * Does not write to disk.
 */
export async function applyVirtualBatch(
  workspacePath: string,
  edits: AgentSREdit[],
): Promise<VirtualBatchResult> {
  const command = resolveVerifyCommand(workspacePath);

  if (!adapter.canValidate(workspacePath)) {
    return {
      success: true,
      diagnostics: [],
      applyErrors: [],
      fileCount: 0,
      virtualFiles: new Map<string, string>(),
      verifyCommand: command,
      verifyStdout: "",
      verifyStderr: "",
    };
  }

  return withSandboxWorkspace(workspacePath, async (sandboxPath) => {
    const { virtualFiles, applyErrors } = await applyEditsInSandbox(
      sandboxPath,
      edits,
    );

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
    const diagnostics = adapter.parseDiagnostics(workspacePath, output) as CSharpCompileDiagnostic[];

    return {
      success: verify.exitCode === 0,
      diagnostics: diagnostics.slice(0, 30),
      applyErrors: [],
      fileCount: 0,
      virtualFiles,
      verifyCommand: command,
      verifyStdout: verify.stdout,
      verifyStderr: verify.stderr,
    };
  });
}

export function formatVirtualBatchResult(result: VirtualBatchResult): string {
  return adapter.formatVirtualBatchResult(result as GenericVirtualBatchResult);
}