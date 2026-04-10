import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

const ALLOWED_COMMANDS = new Set([
  "npm", "npx", "ls", "git", "mkdir", "cat", "grep", "pwd", "node", "tsc"
]);

const DENIED_KEYWORDS = [
  "rm -rf", "sudo", "chmod", "chown", "mkfs", ">", ">>", "|", "&"
];

/**
 * Executes a terminal command safely within the workspace path.
 * Uses spawn with shell: false to prevent shell injection.
 */
export async function executeCommand(
  commandLine: string,
  workspacePath: string
): Promise<CommandResult> {
  const trimmedCommand = commandLine.trim();
  const [cmd, ...args] = trimmedCommand.split(/\s+/);

  // 1. Security Validation: Allow-list
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `Security Error: Command '${cmd}' is not in the allow-list.`,
    };
  }

  // 2. Security Validation: Forbidden keywords/operators
  if (DENIED_KEYWORDS.some((keyword) => trimmedCommand.includes(keyword))) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `Security Error: Command contains forbidden keywords or operators.`,
    };
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: workspacePath,
      shell: false, 
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));

    child.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
        success: code === 0,
      });
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `Execution Error: ${err.message}`,
      });
    });
  });
}