import { spawn, execSync } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Limits the length of a command output to prevent context window explosion.
 * Truncates from the middle, leaving the beginning (initial errors/output)
 * and the end (final status/summary) intact.
 */
export function limitCommandOutput(
  output: string,
  maxChars: number = 6000,
): string {
  if (output.length <= maxChars) {
    return output;
  }
  const half = Math.floor(maxChars / 2);
  const start = output.slice(0, half);
  const end = output.slice(-half);
  const truncatedLength = output.length - maxChars;
  const linesTruncated = output.slice(half, -half).split("\n").length;

  return `${start}\n\n[... Truncated ${truncatedLength} characters (${linesTruncated} lines) of middle output for context safety ...]\n\n${end}`;
}

const ALLOWED_COMMANDS = new Set([
  "npm",
  "npx",
  "ls",
  "git",
  "mkdir",
  "cat",
  "grep",
  "pwd",
  "node",
  "tsc",
  "find",
  "ng",
  "env",
  "curl",
  "rtk",
  "which",
  "date",
  "printf",
]);

const DENIED_KEYWORDS = [
  "rm -rf",
  "sudo",
  "chmod",
  "chown",
  "mkfs",
  //">",
  //">>",
  //"|",
  //"&",
];

let rtkAvailableCache: boolean | undefined = undefined;

function isRtkAvailable(): boolean {
  if (rtkAvailableCache !== undefined) return rtkAvailableCache;
  try {
    execSync("command -v rtk", { stdio: "ignore" });
    rtkAvailableCache = true;
  } catch {
    rtkAvailableCache = false;
  }
  return rtkAvailableCache;
}

/**
 * Parses a command line string into tokens, respecting single and double
 * quoted strings. Quotes are stripped from the resulting tokens.
 * Example: `grep -r "some pattern" src` → ["grep", "-r", "some pattern", "src"]
 */
function parseCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of commandLine) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Executes a terminal command safely within the workspace path.
 * Uses spawn with shell: false to prevent shell injection.
 */
export async function executeCommand(
  commandLine: string,
  workspacePath: string,
): Promise<CommandResult> {
  const trimmedCommand = commandLine.trim();
  const [cmd, ...args] = parseCommandLine(trimmedCommand);

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

  const useRtk = isRtkAvailable() && cmd !== "rtk";
  const finalCmd = useRtk ? "rtk" : cmd;
  const finalArgs = useRtk ? [cmd, ...args] : args;

  return new Promise((resolve) => {
    const child = spawn(finalCmd, finalArgs, {
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
