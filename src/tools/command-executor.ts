import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { withToolSpan } from "../telemetry/spans.js";
import { DENIED_KEYWORDS, getAllowedCommands, getAllowedDirs } from "./sandbox-config.js";

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

// Hard wall-clock cap per spawned command. Without it, a command that blocks on stdin (a script
// with input(), a bare `python3`/`cat`) or loops forever never fires "close", the promise never
// resolves, and the WHOLE agent turn hangs with no output (observed). REI_COMMAND_TIMEOUT_MS overrides.
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

function commandTimeoutMs(): number {
  const n = parseInt(process.env.REI_COMMAND_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMMAND_TIMEOUT_MS;
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

// DENIED_KEYWORDS and STATIC_ALLOWED_COMMANDS are imported from sandbox-config.js.
// getAllowedCommands() merges the static set with REI_ALLOWED_COMMANDS env var.
// getAllowedDirs() merges workspace + ~/.rei + REI_ALLOWED_DIRS env var.

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
/** `$NAME` / `${NAME}` — a shell-style variable name, never a positional like `$1`. Keeping the
 *  first character alphabetic is what leaves `awk "{print $1}"` and `curl -w "%{http_code}"` alone. */
const ENV_VAR_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/;

function parseCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (ch === "\\" && !inSingle && /[\r\n]/.test(commandLine[i + 1] ?? "")) {
      // Line continuation. A model writing a long chain formats it the way it would in a shell —
      // `git add … && \` then a newline — and without this the backslash and the newline stayed
      // glued to the next word, so the command NAME became "\<newline>git" and the allow-list
      // rejected a command nobody had typed. Single quotes keep it literal, as a shell does.
      i += commandLine[i + 1] === "\r" && commandLine[i + 2] === "\n" ? 2 : 1;
      // A continuation joins the two lines into one word boundary, not into one word.
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (/[ \t\r\n]/.test(ch) && !inSingle && !inDouble) {
      // Any unquoted whitespace separates, not just a space: a multi-line command otherwise carried
      // its newline into the token.
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else if (ch === "$" && !inSingle) {
      // Env expansion with SHELL SEMANTICS: unquoted and double-quoted expand, single-quoted does
      // not. We run commands with `shell: false`, so without this `curl -H "Authorization: Bearer
      // $TOKEN"` sends the literal string and the model gets an unexplained 401. The single-quote
      // rule is not cosmetic — `awk '{print $1}'` and `sed 's/$x/y/'` are allow-listed and would
      // break under naive expansion. Deliberate deviation from the shell: an UNDEFINED variable
      // stays literal instead of becoming empty, so the failure names the missing variable in the
      // output rather than silently sending `Bearer `.
      const m = ENV_VAR_RE.exec(commandLine.slice(i));
      const value = m ? process.env[m[1]] : undefined;
      if (m && value !== undefined) {
        current += value;
        i += m[0].length - 1;
      } else {
        current += ch;
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
  const allowedDirs = getAllowedDirs(workspaceRoot);
  if (!allowedDirs.some((d) => normalized === d || normalized.startsWith(d + path.sep))) {
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
  const allowedDirs = getAllowedDirs(workspaceRoot);
  if (!allowedDirs.some((d) => norm === d || norm.startsWith(d + path.sep))) {
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

/** Expands `$VAR` / `${VAR}` in an unquoted heredoc body — the same rule parseCommandLine applies
 *  to the command line. A quoted delimiter (<<'EOF') skips this entirely. */
function expandEnvVars(text: string): string {
  return text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => {
    const value = process.env[name];
    return value === undefined ? whole : value;
  });
}

/**
 * Splits `cmd <<'EOF' … EOF` into the command line and the heredoc body.
 *
 * Heredocs MUST be handled before any splitting. Commands run with `shell: false`, so nothing
 * interprets `<<` — the body used to be tokenized as ARGUMENTS, the process got an empty stdin, and
 * a `python3 - <<EOF` script exited 0 having done nothing (a silent no-op the model reads as
 * success). Worse, `;`, `&&` and `/` inside the body were treated as command separators, producing
 * confusing failures like `Security Error: Command 'break' is not in the allow-list.` — the `;` in
 * a Python line `end = i; break`.
 *
 * Supports `<<WORD`, `<<'WORD'`, `<<"WORD"` and `<<-WORD`. Quoting the delimiter is the shell's way
 * of saying "don't expand anything in here", which is what the body of a script always wants;
 * unquoted delimiters expand `$VAR` the same way the rest of the command line does.
 * Returns null when there's no heredoc, so the normal path is untouched.
 */
function extractHeredoc(
  commandLine: string,
): { command: string; body: string; expand: boolean; rest: string } | null {
  const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(commandLine);
  if (!m) return null;

  const [matched, dash, quote, delimiter] = m;
  const before = commandLine.slice(0, m.index).trimEnd();
  const after = commandLine.slice(m.index + matched.length);
  const lines = after.split("\n");
  // The body starts on the NEXT line; anything trailing on the same line stays with the command
  // (e.g. `cat <<'EOF' > out.txt`).
  const trailing = lines.shift() ?? "";

  const endIndex = lines.findIndex(
    (l) => (dash ? l.trimStart() : l).trimEnd() === delimiter,
  );
  if (endIndex === -1) return null; // no closing delimiter — not a heredoc we can honor

  const bodyLines = dash ? lines.slice(0, endIndex).map((l) => l.replace(/^\t+/, "")) : lines.slice(0, endIndex);
  return {
    command: `${before} ${trailing}`.trim(),
    body: bodyLines.join("\n") + "\n",
    expand: quote === "",
    // Everything after the terminator line is ordinary follow-up work (`wc -l out.txt`). Dropping
    // it silently would make the model believe a step ran when it never did.
    rest: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

/** Spawns a single validated command (no operators/redirects) in the given cwd.
 *  `stdinInput` feeds a heredoc body to the child; without it stdin stays /dev/null. */
function runSpawn(
  finalCmd: string,
  finalArgs: string[],
  cwd: string,
  stdinInput?: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(finalCmd, finalArgs, {
      cwd,
      shell: false,
      // stdin = ignore (/dev/null) by default: a script that reads stdin — input(), sys.stdin, a
      // bare `python3`/`cat` — gets immediate EOF instead of blocking the turn forever waiting for
      // input. A heredoc is the one case with real input to deliver, so it gets a pipe.
      stdio: [stdinInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    if (stdinInput !== undefined) {
      child.stdin!.on("error", () => {}); // child exited before reading — EPIPE is not our problem
      child.stdin!.end(stdinInput);
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    // Safety net for a genuine infinite loop: kill the process and return what we have.
    const timeoutMs = commandTimeoutMs();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        success: false,
        exitCode: -1,
        stdout: stdout.trim(),
        stderr: (stderr + `\n[REI] Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`).trim(),
      });
    }, timeoutMs);

    child.stdout!.on("data", (data) => (stdout += data.toString()));
    child.stderr!.on("data", (data) => (stderr += data.toString()));

    child.on("close", (code) => {
      finish({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, success: code === 0 });
    });

    child.on("error", (err) => {
      finish({ success: false, exitCode: -1, stdout: "", stderr: `Execution Error: ${err.message}` });
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
 * Shell features REI cannot run, and what to do instead.
 *
 * Commands are spawned with `shell: false` and each segment is allow-list checked — that is what the
 * sandbox rests on, so these are not oversights to be fixed by adding a name to a list.
 *
 * They failed in two different ways, and the quieter one was worse:
 *   - Control flow (`for`, `while`, `if`) hit "Command 'for' is not in the allow-list", which reads
 *     as "add it to the list" and sends the model down a dead end. Loud but misleading.
 *   - Command substitution `$(…)` / backticks passed through LITERALLY with exit 0. `curl -H
 *     "Bearer $(cat token)"` sent the text `$(cat token)` as the token: no error, wrong result, and
 *     the 401 that follows points nowhere near the cause.
 *
 * Both now return an explanation naming a real alternative — heredocs work (see extractHeredoc), so
 * a loop can run inside a script.
 */
function unsupportedShellFeature(segment: string): string | null {
  const firstWord = segment.trim().split(/\s+/)[0];
  if (["for", "while", "until", "if", "case", "select", "function"].includes(firstWord)) {
    return (
      `ERROR: shell control flow ('${firstWord}') is not available — commands run without a shell.\n` +
      `Instead: one command per call (chain with && or |), or 'find … -exec', or put the loop in a ` +
      `script via a heredoc, e.g.  python3 - <<'PY' … PY`
    );
  }
  // Only OUTSIDE single quotes: inside them it is literal text, the same rule env expansion follows.
  if (hasUnquotedSubstitution(segment)) {
    return (
      `ERROR: command substitution ($(…) or backticks) is not available — commands run without a ` +
      `shell, so it would be sent as literal text rather than executed.\n` +
      `Instead: run the inner command first and use its output, or do both steps in one script via ` +
      `a heredoc, e.g.  python3 - <<'PY' … PY`
    );
  }
  return null;
}

/** True when `$(` or a backtick appears outside single quotes. */
function hasUnquotedSubstitution(segment: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && (ch === "`" || (ch === "$" && segment[i + 1] === "("))) return true;
  }
  return false;
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

  // Re-check the keywords AFTER expansion: the scan above reads the raw segment, so a variable
  // holding "rm -rf" would have slipped past it by indirection.
  const expanded = cleanArgs.join(" ");
  if (expanded !== segment && DENIED_KEYWORDS.some((k) => expanded.includes(k))) {
    return { ok: false, error: "Security Error: Command contains forbidden keywords or operators." };
  }

  const allowed = getAllowedCommands();
  if (!allowed.includes(cmd)) {
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
    const allowedDirs = getAllowedDirs(workspaceRoot);
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
  stdinInput?: string,
): Promise<CommandResult> {
  const prep = prepareCommand(segment, cwd, workspaceRoot);
  if (!prep.ok) return { success: false, exitCode: -1, stdout: "", stderr: prep.error };

  const result = await runSpawn(prep.prepared.finalCmd, prep.prepared.finalArgs, cwd, stdinInput);
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
    const children = prepared.map((p, i) =>
      spawn(p.finalCmd, p.finalArgs, {
        cwd,
        shell: false,
        // Only the FIRST stage's stdin is closed (/dev/null) so it can't block on input; the rest
        // receive their stdin from the previous stage's piped stdout.
        stdio: [i === 0 ? "ignore" : "pipe", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      }),
    );

    let settled = false;
    const finish = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timeoutMs = commandTimeoutMs();
    const timer = setTimeout(() => {
      for (const c of children) c.kill("SIGKILL");
      finish({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: `[REI] Pipeline timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`,
      });
    }, timeoutMs);

    // Wire stdout → stdin between consecutive stages; swallow EPIPE when a
    // downstream stage (e.g. head) exits early and closes its stdin.
    for (let i = 0; i < children.length - 1; i++) {
      children[i].stdout!.pipe(children[i + 1].stdin!);
      children[i].stdout!.on("error", () => {});
      children[i + 1].stdin!.on("error", () => {});
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

    children[lastIdx].stdout!.on("data", (d) => (lastStdout += d.toString()));

    children.forEach((child, i) => {
      let cstderr = "";
      child.stderr!.on("data", (d) => (cstderr += d.toString()));
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
          finish({ success: false, exitCode: -1, stdout: "", stderr: spawnErr });
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
        finish(applyRedirects(result, prepared[lastIdx].redir, cwd, workspaceRoot));
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
  stdinInput?: string,
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
    // A heredoc body feeds the LAST segment — `cd dir && python3 - <<'PY'` attaches the script to
    // python3, not to cd.
    const segStdin = i === segments.length - 1 ? stdinInput : undefined;
    last =
      stages.length > 1
        ? await runPipeline(stages, cwd, workspaceRoot)
        : await executeSingleSegment(seg, cwd, workspaceRoot, segStdin);
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
  // Unsupported shell features are rejected ONCE, over the whole line and before any splitting.
  // Per-segment it produced three messages for one construct — `for …` explained properly, then
  // `do` and `done` each blaming the allow-list — which buries the explanation in noise.
  // Checked after the heredoc split below would be too late for control flow, and before it would
  // scan the heredoc BODY, where `$(` and backticks are ordinary script text. So: check the command
  // portion only.
  const heredocForCheck = extractHeredoc(commandLine.trim());
  const lineToCheck = heredocForCheck ? heredocForCheck.command : commandLine.trim();
  const unsupported = unsupportedShellFeature(lineToCheck);
  if (unsupported) {
    return { success: false, exitCode: -1, stdout: "", stderr: unsupported };
  }

  // A heredoc is resolved FIRST so its body is never split — the body is data, not commands. What
  // stays is a normal statement list, so `cd`, `&&` and pipes keep working around it.
  const heredoc = extractHeredoc(commandLine.trim());
  const statements: { text: string; stdin?: string }[] = heredoc
    ? [
        {
          text: heredoc.command,
          stdin: heredoc.expand ? expandEnvVars(heredoc.body) : heredoc.body,
        },
        // Lines after the terminator are separate statements (a heredoc ends at its own line, so a
        // newline is the separator there — unlike the single-line `;` case).
        ...heredoc.rest
          .split("\n")
          .flatMap((line) => splitOnSemicolon(line))
          .map((text) => ({ text })),
      ]
    : splitOnSemicolon(commandLine.trim()).map((text) => ({ text }));

  let cwd = workspacePath;
  let combinedStdout = "";
  let combinedStderr = "";
  let last: CommandResult = { success: true, exitCode: 0, stdout: "", stderr: "" };

  const appendOut = (s: string) => { if (s) combinedStdout += (combinedStdout ? "\n" : "") + s; };
  const appendErr = (s: string) => { if (s) combinedStderr += (combinedStderr ? "\n" : "") + s; };

  for (const { text: statement, stdin: statementStdin } of statements) {
    const { result, cwd: nextCwd } = await executeStatement(statement, cwd, workspacePath, statementStdin);
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
