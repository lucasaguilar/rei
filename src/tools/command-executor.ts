import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
  // Node / JS / TS
  "npm", "npx", "node", "tsc", "ng",
  // Python
  "python", "python3", "pip", "pip3", "uv",
  // Go
  "go",
  // Rust
  "cargo",
  // Java / Kotlin
  "mvn", "gradle", "java", "javac", "kotlin",
  // PHP
  "php", "composer",
  // .NET / C#
  "dotnet",
  // Shell utilities
  "ls", "find", "grep", "cat", "pwd", "mkdir",
  "curl", "git", "env", "which", "date", "printf", "echo",
  "true", "false", "test",
  // macOS automation
  "osascript",
  // REI internal
  "rtk",
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
 * Splits a command line on top-level `&&` and `||` operators, respecting single
 * and double quotes so `git commit -m "a && b"` is NOT split inside the quotes.
 * Returns the segments and the operators joining them (operators[i] sits between
 * segments[i] and segments[i+1]).
 */
function splitOnLogicalOps(commandLine: string): { segments: string[]; operators: ("&&" | "||")[] } {
  const segments: string[] = [];
  const operators: ("&&" | "||")[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;

    if (!inSingle && !inDouble && (ch === "&" || ch === "|") && commandLine[i + 1] === ch) {
      segments.push(current.trim());
      operators.push((ch + ch) as "&&" | "||");
      current = "";
      i++; // skip the second operator char
      continue;
    }
    current += ch;
  }
  segments.push(current.trim());
  return { segments, operators };
}

/**
 * Resolves a `cd` target against the current working directory and validates
 * it stays within the workspace root. Returns the new absolute cwd, or an error.
 */
function resolveCdTarget(
  rawPath: string,
  cwd: string,
  workspaceRoot: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  const absPath = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
  const normalized = path.normalize(absPath);
  const normalizedRoot = path.normalize(workspaceRoot);

  if (normalized !== normalizedRoot && !normalized.startsWith(normalizedRoot + path.sep)) {
    return { ok: false, error: `Security Error: cd target '${rawPath}' is outside the workspace.` };
  }
  if (!fs.existsSync(normalized)) {
    return { ok: false, error: `cd: no such directory: ${rawPath}` };
  }
  return { ok: true, cwd: normalized };
}

interface Redirects {
  discardStdout: boolean;
  discardStderr: boolean;
  stderrToStdout: boolean;
  stdoutFile?: { path: string; append: boolean };
  stderrFile?: { path: string; append: boolean };
  bothFile?: { path: string; append: boolean };
}

/**
 * Extracts shell redirection operators from a single command segment, returning
 * the clean argument list (without redirects) and the parsed redirection intent.
 * Supports: `2>/dev/null`, `2>&1`, `>/dev/null`, `>file`, `>>file`, `1>file`, `&>file`.
 */
function extractRedirects(segment: string): { args: string[]; redir: Redirects } {
  const tokens = parseCommandLine(segment);
  const args: string[] = [];
  const redir: Redirects = { discardStdout: false, discardStderr: false, stderrToStdout: false };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let m: RegExpMatchArray | null;

    if (t === "2>&1") {
      redir.stderrToStdout = true;
      continue;
    }
    // both stdout+stderr: &>file / &>>file
    if ((m = t.match(/^&>>?(.*)$/))) {
      const append = t.startsWith("&>>");
      const target = m[1] || tokens[++i] || "";
      if (target === "/dev/null") { redir.discardStdout = true; redir.discardStderr = true; }
      else redir.bothFile = { path: target, append };
      continue;
    }
    // stderr: 2>target / 2>>target
    if ((m = t.match(/^2>>?(.*)$/))) {
      const append = t.startsWith("2>>");
      const target = m[1] || tokens[++i] || "";
      if (target === "/dev/null") redir.discardStderr = true;
      else if (target === "&1") redir.stderrToStdout = true;
      else redir.stderrFile = { path: target, append };
      continue;
    }
    // stdout: >target / >>target / 1>target / 1>>target
    if ((m = t.match(/^1?>>?(.*)$/))) {
      const append = /^1?>>/.test(t);
      const target = m[1] || tokens[++i] || "";
      if (target === "/dev/null") redir.discardStdout = true;
      else redir.stdoutFile = { path: target, append };
      continue;
    }
    args.push(t);
  }
  return { args, redir };
}

/** Writes redirected output to a file, validating it stays within the workspace. */
function writeRedirectFile(
  target: string,
  cwd: string,
  workspaceRoot: string,
  content: string,
  append: boolean,
): string | null {
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  const norm = path.normalize(abs);
  const root = path.normalize(workspaceRoot);
  if (norm !== root && !norm.startsWith(root + path.sep)) {
    return `Security Error: redirect target '${target}' is outside the workspace.`;
  }
  try {
    if (append) fs.appendFileSync(norm, content ? content + "\n" : "");
    else fs.writeFileSync(norm, content ? content + "\n" : "");
    return null;
  } catch (e) {
    return `redirect write failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Spawns a single validated command (no operators/redirects) in the given cwd. */
function runSpawn(finalCmd: string, finalArgs: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(finalCmd, finalArgs, {
      cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));

    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, success: code === 0 });
    });

    child.on("error", (err) => {
      resolve({ success: false, exitCode: -1, stdout: "", stderr: `Execution Error: ${err.message}` });
    });
  });
}

/** Runs one command segment (allow-list + redirects), in the given cwd. */
async function executeSingleSegment(
  segment: string,
  cwd: string,
  workspaceRoot: string,
): Promise<CommandResult> {
  // Forbidden keywords/operators (rm -rf, sudo, ...)
  if (DENIED_KEYWORDS.some((keyword) => segment.includes(keyword))) {
    return { success: false, exitCode: -1, stdout: "", stderr: `Security Error: Command contains forbidden keywords or operators.` };
  }

  const { args: cleanArgs, redir } = extractRedirects(segment);
  const [cmd, ...args] = cleanArgs;

  if (!cmd) {
    return { success: false, exitCode: -1, stdout: "", stderr: "Empty command." };
  }

  // Allow-list
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return { success: false, exitCode: -1, stdout: "", stderr: `Security Error: Command '${cmd}' is not in the allow-list.` };
  }

  const useRtk = isRtkAvailable() && cmd !== "rtk";
  const finalCmd = useRtk ? "rtk" : cmd;
  const finalArgs = useRtk ? [cmd, ...args] : args;

  const result = await runSpawn(finalCmd, finalArgs, cwd);

  // Apply redirections to the captured output.
  if (redir.stderrToStdout) {
    result.stdout = [result.stdout, result.stderr].filter(Boolean).join("\n");
    result.stderr = "";
  }
  const failRedirect = (err: string) => {
    result.stderr = err;
    result.success = false;
    if (result.exitCode === 0) result.exitCode = 1;
  };

  if (redir.bothFile) {
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const err = writeRedirectFile(redir.bothFile.path, cwd, workspaceRoot, combined, redir.bothFile.append);
    if (err) failRedirect(err); else { result.stdout = ""; result.stderr = ""; }
  } else {
    if (redir.stdoutFile) {
      const err = writeRedirectFile(redir.stdoutFile.path, cwd, workspaceRoot, result.stdout, redir.stdoutFile.append);
      if (err) failRedirect(err); else result.stdout = "";
    } else if (redir.discardStdout) {
      result.stdout = "";
    }
    if (redir.stderrFile) {
      const err = writeRedirectFile(redir.stderrFile.path, cwd, workspaceRoot, result.stderr, redir.stderrFile.append);
      if (err) failRedirect(err); else result.stderr = "";
    } else if (redir.discardStderr) {
      result.stderr = "";
    }
  }

  return result;
}

/**
 * Executes a terminal command safely within the workspace path.
 * Supports `cd <dir>` (validated to stay in the workspace), `&&`/`||` chaining
 * with proper short-circuit semantics, and output redirection
 * (`2>/dev/null`, `2>&1`, `>file`, `>>file`, `&>file`). `cd` updates the working
 * directory for subsequent segments.
 */
export async function executeCommand(
  commandLine: string,
  workspacePath: string,
): Promise<CommandResult> {
  const { segments, operators } = splitOnLogicalOps(commandLine.trim());

  let cwd = workspacePath;
  let combinedStdout = "";
  let combinedStderr = "";
  let last: CommandResult = { success: true, exitCode: 0, stdout: "", stderr: "" };

  const appendOut = (s: string) => { if (s) combinedStdout += (combinedStdout ? "\n" : "") + s; };
  const appendErr = (s: string) => { if (s) combinedStderr += (combinedStderr ? "\n" : "") + s; };

  for (let i = 0; i < segments.length; i++) {
    // Short-circuit based on the operator joining us to the previous segment.
    if (i > 0) {
      const op = operators[i - 1];
      if (op === "&&" && !last.success) continue; // prior failed → skip &&-chained
      if (op === "||" && last.success) continue;  // prior succeeded → skip ||-fallback
    }

    const seg = segments[i];

    // cd <dir> — changes cwd for subsequent segments (validated to stay in workspace)
    const cdMatch = seg.match(/^cd(?:\s+(\S+))?$/);
    if (cdMatch) {
      const target = cdMatch[1];
      if (!target) {
        last = { success: true, exitCode: 0, stdout: `(now in ${cwd})`, stderr: "" };
        continue;
      }
      const res = resolveCdTarget(target, cwd, workspacePath);
      if (!res.ok) {
        last = { success: false, exitCode: res.error.startsWith("Security") ? -1 : 1, stdout: "", stderr: res.error };
        appendErr(res.error);
        continue;
      }
      cwd = res.cwd;
      last = { success: true, exitCode: 0, stdout: segments.length === 1 ? `(now in ${cwd})` : "", stderr: "" };
      appendOut(last.stdout);
      continue;
    }

    last = await executeSingleSegment(seg, cwd, workspacePath);
    appendOut(last.stdout);
    appendErr(last.stderr);
  }

  return {
    success: last.success,
    exitCode: last.exitCode,
    stdout: combinedStdout.trim(),
    stderr: combinedStderr.trim(),
  };
}
