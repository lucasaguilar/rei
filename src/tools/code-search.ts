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
  const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "240"];
  if (params.glob) rgArgs.push("--glob", params.glob);
  rgArgs.push("--regexp", pattern);
  if (params.path) rgArgs.push("--", params.path);

  let res = await run("rg", rgArgs, workspacePath);

  if (res.missing) {
    // Fallback: POSIX grep. -r recursive, -n line numbers, -E extended regex, -I skip binary.
    const grepArgs = ["-rnIE", "--", pattern, params.path || "."];
    res = await run("grep", grepArgs, workspacePath);
    if (res.missing) {
      return "ERROR: neither ripgrep (rg) nor grep is available to search.";
    }
  }

  const allLines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
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

  const rgArgs = ["--files"];
  if (params.glob) rgArgs.push("--glob", params.glob);
  if (params.path) rgArgs.push("--", params.path);
  let res = await run("rg", rgArgs, workspacePath);

  if (res.missing) {
    // Fallback: find. Approximate a glob with -name on the basename pattern.
    const findArgs = [params.path || ".", "-type", "f"];
    if (params.glob) findArgs.push("-name", params.glob.replace(/^.*\//, ""));
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
