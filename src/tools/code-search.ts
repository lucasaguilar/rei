/**
 * @fileoverview Code navigation tools that return BOUNDED, structured output — REI controls the size
 * (match count + top-N + "narrow it" hint) instead of dumping raw shell output that gets mid-truncated
 * by the run_command cap or the backend. Powers the model's on-demand discovery of a large repo
 * without reading whole files. Uses ripgrep when available, falls back to POSIX grep/find.
 *
 * @module rei/tools/code-search
 */

import { spawn } from "node:child_process";

interface RunResult {
  stdout: string;
  code: number | null;
  missing: boolean; // the binary isn't installed (ENOENT)
  capped: boolean; // output exceeded the byte cap → we stopped early (there are more results)
}

/** Max bytes of output we accumulate before killing the child — guards against a pattern with
 *  millions of matches blowing V8's string limit (RangeError). ~2 MB is plenty for a bounded list. */
const MAX_OUTPUT_BYTES = 2_000_000;

/** Per-line cap, matching the `--max-columns` value passed to ripgrep. */
const MAX_LINE_CHARS = 240;

/**
 * Directories the POSIX fallbacks prune.
 *
 * Ripgrep reads `.gitignore` and needs no list; `grep` and `find` read nothing, so without this
 * they walk `node_modules/` and `.rei/` — the two places where a single minified line (a vendored
 * bundle, a 13 MB rag-index on ONE line) eats the entire output budget and starves every real
 * result. This is an approximation of `.gitignore`, not a substitute: it covers the directories
 * that are ignored in practice in every project, and nothing project-specific.
 */
const FALLBACK_PRUNE_DIRS = [
  "node_modules",
  ".git",
  ".rei",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "target",
  ".next",
  ".cache",
];

function run(cmd: string, args: string[], cwd: string, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let capped = false;
    let settled = false;
    const done = (r: RunResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd });
    } catch {
      return done({ stdout: "", code: null, missing: true, capped: false });
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ stdout, code: null, missing: false, capped });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        capped = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ stdout: "", code: null, missing: err.code === "ENOENT", capped });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, code, missing: false, capped });
    });
  });
}

export interface GrepParams {
  pattern: string;
  /** Restrict to a subdirectory or file (relative to the workspace). */
  path?: string;
  /** Restrict to files matching a glob, e.g. "*.ts" or "src/**\/*.tsx". */
  glob?: string;
  /** Max matches to return (default 50). */
  maxResults?: number;
}

/** grep_code → ripgrep (fallback grep). Returns bounded `file:line: text` matches + a count. */
export async function grepCode(workspacePath: string, params: GrepParams): Promise<string> {
  const pattern = (params.pattern ?? "").trim();
  if (!pattern) return "ERROR: grep_code requires a non-empty 'pattern'.";
  const max = params.maxResults && params.maxResults > 0 ? Math.floor(params.maxResults) : 50;

  // Try ripgrep first — fast, respects .gitignore, bounded columns.
  // --no-require-git: ripgrep only applies .gitignore inside a git repo. A workspace that isn't one
  // (a plain folder, a worktree export) would otherwise have node_modules/ walked despite listing it.
  const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "240", "--no-require-git"];
  if (params.glob) rgArgs.push("--glob", params.glob);
  rgArgs.push("--regexp", pattern);
  // ALWAYS pass a search path. With none, ripgrep reads STDIN when stdin isn't a TTY — inside a
  // server/sub-agent/non-interactive run that means grep_code hangs until the timeout and then
  // reports "no matches", which reads to the model as a confident (and wrong) answer.
  rgArgs.push("--", params.path || "./");

  let res = await run("rg", rgArgs, workspacePath);
  // Set when ripgrep is missing and we fall back to POSIX grep, which ignores `glob` and walks
  // ignored dirs. The model must be TOLD — a filter that silently didn't apply is worse than none.
  let degraded = false;

  if (res.missing) {
    // Fallback: POSIX grep. -r recursive, -n line numbers, -E extended regex, -I skip binary.
    // BSD (macOS) and GNU grep both accept --include / --exclude-dir, so the fallback can honor the
    // glob and skip vendor dirs instead of silently searching everything.
    // --include / --exclude-dir are accepted by both BSD (macOS) and GNU grep, so the fallback can
    // honor the glob and skip vendor dirs instead of searching everything. They used to be
    // described in this comment but never passed, which is how a run without ripgrep came back
    // with matches from node_modules and from a 13 MB minified line.
    const grepArgs = ["-rnIE"];
    if (params.glob) grepArgs.push(`--include=${params.glob.replace(/^.*\//, "")}`);
    for (const dir of FALLBACK_PRUNE_DIRS) grepArgs.push(`--exclude-dir=${dir}`);
    grepArgs.push("--", pattern, params.path || ".");
    degraded = true;
    res = await run("grep", grepArgs, workspacePath);
    if (res.missing) {
      return "ERROR: neither ripgrep (rg) nor grep is available to search.";
    }
  }

  // Both search roots ("./" for rg, "." for the grep fallback) echo back a "./" prefix on every
  // path. Strip it so what the model gets can be handed straight to read_files.
  //
  // The length clamp mirrors ripgrep's --max-columns for the POSIX fallback, which has no equivalent:
  // one match inside a minified file (this repo's .rei/rag-index.json is 13.5 MB on a SINGLE line)
  // otherwise consumes the whole MAX_OUTPUT_BYTES budget and starves every real result. Capping the
  // line beats excluding directories — it holds for a minified bundle anywhere, listed or not.
  const allLines = res.stdout
    .split("\n")
    .map((l) => l.replace(/^\.\//, ""))
    .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l))
    .filter((l) => l.trim().length > 0);
  if (allLines.length === 0) {
    return `grep_code "${pattern}"${params.glob ? ` (glob ${params.glob})` : ""}${params.path ? ` in ${params.path}` : ""} — no matches.`;
  }

  const shown = allLines.slice(0, max);
  const header = res.capped
    ? `grep_code "${pattern}" — many matches (output capped, showing first ${max})`
    : `grep_code "${pattern}" — ${allLines.length} match${allLines.length === 1 ? "" : "es"}` +
      (allLines.length > max ? ` (showing first ${max})` : "");
  let out = `${header}\n${shown.join("\n")}`;
  if (res.capped) {
    out += `\n… TOO MANY matches (output capped) — narrow the pattern, or pass a 'path'/'glob' to scope the search.`;
  } else if (allLines.length > max) {
    out += `\n… and ${allLines.length - max} more — narrow the pattern, or pass a 'path'/'glob' to scope the search.`;
  }
  if (degraded) {
    out += `\n(NOTE: ripgrep is not installed — this used POSIX grep, which matches the glob on the FILE NAME only and prunes a fixed list of vendor dirs rather than reading .gitignore. Install ripgrep for exact results.)`;
  }
  return out;
}

export interface ListFilesParams {
  /** Glob to match file paths, e.g. "**\/*.component.ts". Omit to list everything (bounded). */
  glob?: string;
  /** Restrict to a subdirectory (relative to the workspace). */
  path?: string;
  /** Max paths to return (default 200). */
  maxResults?: number;
}

/** list_files → ripgrep --files (fallback find). Returns bounded file paths matching a glob. */
export async function listFiles(workspacePath: string, params: ListFilesParams): Promise<string> {
  const max = params.maxResults && params.maxResults > 0 ? Math.floor(params.maxResults) : 200;

  const rgArgs = ["--files", "--no-require-git"];
  if (params.glob) rgArgs.push("--glob", params.glob);
  rgArgs.push("--", params.path || "./"); // explicit path — never let ripgrep fall back to stdin
  let res = await run("rg", rgArgs, workspacePath);

  if (res.missing) {
    // Fallback: find. Approximate a glob with -name on the basename pattern.
    // `find` walks everything unless told otherwise: without the prune, list_files answered with
    // thousands of node_modules paths on any machine without ripgrep.
    const findArgs = [params.path || "."];
    findArgs.push("(");
    FALLBACK_PRUNE_DIRS.forEach((dir, i) => {
      if (i > 0) findArgs.push("-o");
      findArgs.push("-name", dir);
    });
    findArgs.push(")", "-prune", "-o", "-type", "f");
    if (params.glob) findArgs.push("-name", params.glob.replace(/^.*\//, ""));
    findArgs.push("-print");
    res = await run("find", findArgs, workspacePath);
    if (res.missing) return "ERROR: neither ripgrep (rg) nor find is available to list files.";
  }

  const all = res.stdout.split("\n").map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean);
  if (all.length === 0) {
    return `list_files${params.glob ? ` (glob ${params.glob})` : ""}${params.path ? ` in ${params.path}` : ""} — no files.`;
  }
  const shown = all.slice(0, max);
  const label = res.capped
    ? `many files (output capped, showing first ${max})`
    : `${all.length} file${all.length === 1 ? "" : "s"}${all.length > max ? ` (showing first ${max})` : ""}`;
  let out = `list_files — ${label}\n${shown.join("\n")}`;
  if (res.capped) out += `\n… TOO MANY files (output capped) — narrow with a 'glob' or 'path'.`;
  else if (all.length > max) out += `\n… and ${all.length - max} more — narrow with a 'glob' or 'path'.`;
  return out;
}
