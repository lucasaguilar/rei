import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { AgentProposedPatch } from "../../contracts/agent-decision.types.js";
import { applyPatchToFS } from "../../tools/patch-applier.js";

const execFileAsync = promisify(execFile);

export interface SandboxVerificationResult {
  verified: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  patchCount: number;
  failedPatchFiles: string[];
}

export async function verifyPatchBatchInSandbox(params: {
  workspacePath: string;
  proposals: AgentProposedPatch[];
}): Promise<SandboxVerificationResult> {
  const { workspacePath, proposals } = params;
  const command = "npx tsc --noEmit";

  if (proposals.length === 0) {
    return {
      verified: true,
      command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      patchCount: 0,
      failedPatchFiles: [],
    };
  }

  const sandboxPath = await createSandboxCopy(workspacePath);

  try {
    const failedPatchFiles: string[] = [];

    for (const proposal of proposals) {
      const applied = await applyPatchToFS(proposal.patch, sandboxPath, {
        dryRun: false,
      });
      if (!applied.applied) {
        failedPatchFiles.push(proposal.file);
      }
    }

    if (failedPatchFiles.length > 0) {
      return {
        verified: false,
        command,
        exitCode: 2,
        stdout: "",
        stderr: `Failed to apply patches in sandbox: ${failedPatchFiles.join(", ")}`,
        patchCount: proposals.length,
        failedPatchFiles,
      };
    }

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_OPTIONS;
    delete cleanEnv.VSCODE_INSPECTOR_OPTIONS;

    try {
      const { stdout, stderr } = await execFileAsync(
        "npx",
        ["tsc", "--noEmit"],
        {
          cwd: sandboxPath,
          env: cleanEnv,
        },
      );

      return {
        verified: true,
        command,
        exitCode: 0,
        stdout,
        stderr,
        patchCount: proposals.length,
        failedPatchFiles: [],
      };
    } catch (error) {
      const err = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      return {
        verified: false,
        command,
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "tsc failed",
        patchCount: proposals.length,
        failedPatchFiles: [],
      };
    }
  } finally {
    if (process.env.REI_KEEP_SANDBOX !== "1") {
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  }
}

async function createSandboxCopy(workspacePath: string): Promise<string> {
  const reiTmpRoot = path.join(workspacePath, ".rei", "tmp");
  await fs.mkdir(reiTmpRoot, { recursive: true });

  const sandboxPath = path.join(
    reiTmpRoot,
    `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  );

  await fs.mkdir(sandboxPath, { recursive: true });

  await fs.cp(workspacePath, sandboxPath, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(workspacePath, src);
      if (rel === "") return true;

      const normalized = rel.replace(/\\/g, "/");
      if (normalized === ".git" || normalized.startsWith(".git/")) {
        return false;
      }
      if (normalized === ".rei" || normalized.startsWith(".rei/")) {
        return false;
      }
      if (
        normalized === "node_modules" ||
        normalized.startsWith("node_modules/")
      ) {
        return false;
      }
      return true;
    },
  });

  const sourceNodeModules = path.join(workspacePath, "node_modules");
  const sandboxNodeModules = path.join(sandboxPath, "node_modules");
  try {
    await fs.lstat(sourceNodeModules);
    await fs.symlink(sourceNodeModules, sandboxNodeModules, "junction");
  } catch {
    // If node_modules is missing, npx may still work with cached/global binaries.
  }

  return sandboxPath;
}
