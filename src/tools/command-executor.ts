import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { withToolSpan } from "../telemetry/spans.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Cap (in chars) for a single command's stdout/stderr fed back to the model, protecting the
 * context window. Env-overridable via REI_MAX_COMMAND_OUTPUT. The old 6000 was too small: it cut
 * the MIDDLE out of even a medium source file, so `cat file.ts` showed only head+tail and the model
 * concluded the file was "truncated for safety" and spun re-reading it. 24000 reads typical source
 * files whole; for reading files prefer read_files (uncapped) — this is the safety net for commands.
 */
const DEFAULT_MAX_COMMAND_OUTPUT = 24000;

function maxCommandOutputChars(): number {
  const n = parseInt(process.env.REI_MAX_COMMAND_OUTPUT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COMMAND_OUTPUT;
}

/**
 * Limits the length of a command output to prevent context window explosion.
 * Truncates from the middle, leaving the beginning (initial errors/output)
 * and the end (final status/summary) intact.
 */
export function limitCommandOutput(
  output: string,
  maxChars: number = maxCommandOutputChars(),
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
  "curl", "git", "env", "which", "date", "printf", "echo", "chmod", "command",
  "rm", "tar", "unzip", "file", "wget",
  "true", "false", "test",
  // Read-only text utilities (file exploration: read by parts, slice, count)
  "head", "tail", "sed", "awk", "wc", "sort", "uniq", "cut", "tr",
  // macOS automation
  "osascript",
  // REI internal
  "rtk",
]);

const DENIED_KEYWORDS = [
  "rm -rf",
  "sudo",
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
 * Splits a command line on top-level `&&`, `||` and `/` operators, respecting single
 * and double quotes so `git commit -m "a && b"` is NOT split inside the quotes.
 * The `/` operator lets models chain simple commands (e.g. `ls/grep`) as shorthand
 * for separate executions — equivalent to running each side independently with `;`.
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

    // `&&` and `||` — two-char operators, only outside quotes.
    if (!inSingle && !inDouble && (ch === "&" || ch === "|") && commandLine[i + 1] === ch) {
      segments.push(current.trim());
      operators.push((ch + ch) as "&&" | "||");
      current = "";
      i++; // skip the second operator char
      continue;
    }

    // `/` — single-char operator, only outside quotes. Models use this to chain
    // simple commands (e.g. `ls/grep`). We split on it so each side is validated
    // and executed separately by the allow-list. Paths inside arguments (e.g.
    // `find src/agent-mode -name "*.ts"`) are NOT affected because they appear
    // after a valid command token — only bare top-level segments get split.
    if (!inSingle && !inDouble && ch === "/") {
      const prev = current.trim();
      if (prev.length > 0) {
        segments.push(prev);
        operators.push("&&"); // treat as sequential execution
        current = "";
      }
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

/**
 * Splits a command segment on top-level pipes (`|`), respecting quotes.
 * Assumes `||` was already consumed by splitOnLogicalOps, so any `|` here is a pipe.
 */
function splitOnPipe(segment: string): string[] {
  const stages: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble && ch === "|") {
      stages.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  stages.push(current.trim());
  return stages.filter((s) => s.length > 0);
}

interface PreparedCommand {
  finalCmd: string;
  finalArgs: string[];
  redir: Redirects;
}

/**
 * Validates a single command segment (keywords, allow-list, rm safety) and
 * resolves redirects + the rtk wrapper. Shared by the single-command and
 * pipeline execution paths.
 */
function prepareCommand(
  segment: string,
  cwd: string,
  workspaceRoot: string,
  allowRtk = true,
): { ok: true; prepared: PreparedCommand } | { ok: false; error: string } {
  if (DENIED_KEYWORDS.some((keyword) => segment.includes(keyword))) {
    return { ok: false, error: "Security Error: Command contains forbidden keywords or operators." };
  }

  const { args: cleanArgs, redir } = extractRedirects(segment);
  const [cmd, ...args] = cleanArgs;

  if (!cmd) return { ok: false, error: "Empty command." };

  if (!ALLOWED_COMMANDS.has(cmd)) {
    return { ok: false, error: `Security Error: Command '${cmd}' is not in the allow-list.` };
  }

  // Extra security for 'rm'
  if (cmd === "rm") {
    const hasRecursive = args.some(
      (arg) => arg.startsWith("-") && (/[rR]/.test(arg) || arg === "--recursive"),
    );
    if (hasRecursive) {
      return { ok: false, error: "Security Error: Recursive deletion is not allowed." };
    }
    const homedir = process.env.HOME || os.homedir();
    const allowedDirs = [
      path.normalize(workspaceRoot),
      path.normalize(path.join(homedir, ".rei")),
    ];
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const absPath = path.isAbsolute(arg) ? arg : path.join(cwd, arg);
      const normPath = path.normalize(absPath);
      const isAllowed = allowedDirs.some(
        (dir) => normPath === dir || normPath.startsWith(dir + path.sep),
      );
      if (!isAllowed) {
        return { ok: false, error: `Security Error: rm target '${arg}' is outside the allowed directories (workspace or ~/.rei).` };
      }
    }
  }

  // rtk reformats output to save tokens — great for standalone commands (output
  // goes to the model), but it breaks pipelines, where stages must exchange RAW
  // output. So pipelines pass allowRtk=false and run the real commands.
  const useRtk = allowRtk && isRtkAvailable() && cmd !== "rtk";
  return {
    ok: true,
    prepared: {
      finalCmd: useRtk ? "rtk" : cmd,
      finalArgs: useRtk ? [cmd, ...args] : args,
      redir,
    },
  };
}

/** Applies parsed redirections to a captured command result (in place). */
function applyRedirects(
  result: CommandResult,
  redir: Redirects,
  cwd: string,
  workspaceRoot: string,
): CommandResult {
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

/** Runs one command segment (allow-list + redirects), in the given cwd. */
async function executeSingleSegment(
  segment: string,
  cwd: string,
  workspaceRoot: string,
): Promise<CommandResult> {
  const prep = prepareCommand(segment, cwd, workspaceRoot);
  if (!prep.ok) return { success: false, exitCode: -1, stdout: "", stderr: prep.error };

  const result = await runSpawn(prep.prepared.finalCmd, prep.prepared.finalArgs, cwd);
  return applyRedirects(result, prep.prepared.redir, cwd, workspaceRoot);
}

/**
 * Runs a pipeline (`cmd1 | cmd2 | ... | cmdN`) by spawning each stage and wiring
 * stdout → stdin between them — no shell, so each stage is allow-list validated.
 * The final stage's stdout is captured; redirects on the last stage apply to it.
 */
async function runPipeline(
  stages: string[],
  cwd: string,
  workspaceRoot: string,
): Promise<CommandResult> {
  // Validate EVERY stage before spawning anything — fail fast, spawn nothing on
  // error. allowRtk=false: stages must exchange raw output for pipes to work.
  const prepared: PreparedCommand[] = [];
  for (const stage of stages) {
    const prep = prepareCommand(stage, cwd, workspaceRoot, false);
    if (!prep.ok) return { success: false, exitCode: -1, stdout: "", stderr: prep.error };
    prepared.push(prep.prepared);
  }

  return new Promise((resolve) => {
    const children = prepared.map((p) =>
      spawn(p.finalCmd, p.finalArgs, { cwd, shell: false, env: { ...process.env, FORCE_COLOR: "0" } }),
    );

    // Wire stdout → stdin between consecutive stages; swallow EPIPE when a
    // downstream stage (e.g. head) exits early and closes its stdin.
    for (let i = 0; i < children.length - 1; i++) {
      children[i].stdout.pipe(children[i + 1].stdin);
      children[i].stdout.on("error", () => {});
      children[i + 1].stdin.on("error", () => {});
    }

    const lastIdx = children.length - 1;
    let lastStdout = "";
    const stderrParts: string[] = [];
    let spawnErr: string | null = null;
    let pending = children.length;
    // Exit code + signal of every stage, so we can apply `pipefail` semantics
    // below instead of trusting only the last stage (which masks upstream
    // failures, e.g. `ng build | head` reporting head's 0 for a failed build).
    const exitInfo: Array<{ code: number | null; signal: NodeJS.Signals | null }> =
      new Array(children.length).fill(null);

    children[lastIdx].stdout.on("data", (d) => (lastStdout += d.toString()));

    children.forEach((child, i) => {
      let cstderr = "";
      child.stderr.on("data", (d) => (cstderr += d.toString()));
      child.on("error", (err) => {
        spawnErr = `Execution Error: ${err.message}`;
      });
      child.on("close", (code, signal) => {
        exitInfo[i] = { code, signal };
        // Honor per-stage stderr suppression; last stage's stderr is handled by applyRedirects.
        if (i !== lastIdx && !prepared[i].redir.discardStderr && cstderr.trim()) {
          stderrParts.push(cstderr.trim());
        } else if (i === lastIdx && cstderr.trim()) {
          stderrParts.push(cstderr.trim());
        }
        pending--;
        if (pending > 0) return;

        if (spawnErr) {
          resolve({ success: false, exitCode: -1, stdout: "", stderr: spawnErr });
          return;
        }

        // `pipefail`: the pipeline's exit code is that of the rightmost stage that
        // failed — so an upstream failure (e.g. `ng build` exiting 1) is no longer
        // hidden by a trailing `| head` that exits 0. Exception: a non-last stage
        // killed by SIGPIPE (code 141 / signal SIGPIPE) just means a downstream
        // stage closed the pipe early (normal truncation, e.g. `… | head -50`),
        // NOT a real failure — ignore those so legitimate `cmd | head` still works.
        let effectiveExit = 0;
        for (let s = 0; s <= lastIdx; s++) {
          const info = exitInfo[s];
          if (!info) continue;
          const sigpipeTrunc =
            s !== lastIdx && (info.signal === "SIGPIPE" || info.code === 141);
          const failed = info.signal != null || (info.code != null && info.code !== 0);
          if (failed && !sigpipeTrunc) {
            effectiveExit = info.code ?? 1; // rightmost real failure wins
          }
        }

        const result: CommandResult = {
          stdout: lastStdout.trim(),
          stderr: stderrParts.join("\n").trim(),
          exitCode: effectiveExit,
          success: effectiveExit === 0,
        };
        // Last stage's redirects (e.g. `... | tail -5 > out.txt`) apply to final output.
        resolve(applyRedirects(result, prepared[lastIdx].redir, cwd, workspaceRoot));
      });
    });
  });
}

/**
 * Splits a command line on top-level `;` separators (sequential statements that
 * run regardless of each other's exit code), respecting quotes.
 */
function splitOnSemicolon(commandLine: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble && ch === ";") {
      statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  statements.push(current.trim());
  return statements.filter((s) => s.length > 0);
}

/**
 * Runs one statement (a `&&`/`||` chain of segments, each possibly a pipeline),
 * threading the working directory through any `cd`. Returns the final result and
 * the resulting cwd so callers can carry `cd` across `;`-separated statements.
 */
async function executeStatement(
  statement: string,
  startCwd: string,
  workspaceRoot: string,
): Promise<{ result: CommandResult; cwd: string }> {
  const { segments, operators } = splitOnLogicalOps(statement.trim());

  let cwd = startCwd;
  let combinedStdout = "";
  let combinedStderr = "";
  let last: CommandResult = { success: true, exitCode: 0, stdout: "", stderr: "" };

  const appendOut = (s: string) => { if (s) combinedStdout += (combinedStdout ? "\n" : "") + s; };
  const appendErr = (s: string) => { if (s) combinedStderr += (combinedStderr ? "\n" : "") + s; };

  for (let i = 0; i < segments.length; i++) {
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
      const res = resolveCdTarget(target, cwd, workspaceRoot);
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

    // A pipeline within this segment (cmd1 | cmd2 | ...) runs as a wired chain;
    // a single command runs directly.
    const stages = splitOnPipe(seg);
    last =
      stages.length > 1
        ? await runPipeline(stages, cwd, workspaceRoot)
        : await executeSingleSegment(seg, cwd, workspaceRoot);
    appendOut(last.stdout);
    appendErr(last.stderr);
  }

  return {
    result: {
      success: last.success,
      exitCode: last.exitCode,
      stdout: combinedStdout.trim(),
      stderr: combinedStderr.trim(),
    },
    cwd,
  };
}

/**
 * Executes a terminal command safely within the workspace path.
 * Supports `cd <dir>` (validated to stay in the workspace), `;` sequential
 * statements, `&&`/`||` chaining with proper short-circuit semantics, pipelines
 * (`cmd1 | cmd2`, wired without a shell so each stage is allow-list validated),
 * and output redirection (`2>/dev/null`, `2>&1`, `>file`, `>>file`, `&>file`).
 * `cd` carries across both `&&`/`||` segments and `;` statements.
 */
/**
 * Public entry point. Wraps the run in a `tool.run_command` span (Laminar `spanType: "TOOL"`)
 * so every command — from any of rei's dispatch paths — shows up under the active Turn/Step in
 * the unified trace. The span is a no-op when telemetry isn't initialized.
 */
export async function executeCommand(
  commandLine: string,
  workspacePath: string,
): Promise<CommandResult> {
  return withToolSpan("run_command", { command: commandLine }, () =>
    executeCommandImpl(commandLine, workspacePath),
  );
}

async function executeCommandImpl(
  commandLine: string,
  workspacePath: string,
): Promise<CommandResult> {
  // `;` (lowest precedence) splits sequential statements that run regardless of
  // each other's exit code; `cd` state threads across them.
  const statements = splitOnSemicolon(commandLine.trim());

  let cwd = workspacePath;
  let combinedStdout = "";
  let combinedStderr = "";
  let last: CommandResult = { success: true, exitCode: 0, stdout: "", stderr: "" };

  const appendOut = (s: string) => { if (s) combinedStdout += (combinedStdout ? "\n" : "") + s; };
  const appendErr = (s: string) => { if (s) combinedStderr += (combinedStderr ? "\n" : "") + s; };

  for (const statement of statements) {
    const { result, cwd: nextCwd } = await executeStatement(statement, cwd, workspacePath);
    cwd = nextCwd; // carry `cd` across `;`
    last = result;
    appendOut(result.stdout);
    appendErr(result.stderr);
    // `;` ignores exit codes — always continue to the next statement.
  }

  return {
    success: last.success,
    exitCode: last.exitCode,
    stdout: combinedStdout.trim(),
    stderr: combinedStderr.trim(),
  };
}
