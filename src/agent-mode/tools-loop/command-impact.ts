import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * What a gated command will TOUCH, for the confirm question. The gate used to show only a canned
 * description and the raw command, so `git add -A && git commit` gave the user no way to see which
 * files — a stray `.env` included — were about to be committed.
 *
 * Everything here is READ-ONLY and never runs any part of the command being confirmed: git is
 * queried with execFile (no shell, so a `$(…)` in the model's command is never evaluated), and rm
 * targets are expanded in-process. Any failure yields no detail, never a thrown gate.
 */

const execFileAsync = promisify(execFile);

/** Beyond this, the list is cut with "… and N more": the question is printed in the transcript. */
const MAX_LISTED = 15;

const SECRET_LIKE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|credentials.*)$/i;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000 });
  return stdout;
}

/** The segments of a shell chain, so `git add -A` in one segment and `git commit` in another are
 *  both seen. Not a shell parser — it only needs to find git/rm invocations. */
function segments(cmd: string): string[][] {
  return cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
}

function gitSub(tokens: string[], sub: string): string[] | null {
  return tokens[0] === "git" && tokens[1] === sub ? tokens.slice(2) : null;
}

interface StatusEntry {
  code: string;
  file: string;
}

/** Which entries of `git status --porcelain` the commit will include. */
function selectForCommit(entries: StatusEntry[], segs: string[][]): StatusEntry[] {
  let all = false;
  let trackedAll = false;
  const paths: string[] = [];
  for (const t of segs) {
    const add = gitSub(t, "add");
    if (add) {
      const args = add.filter((a) => !a.startsWith("-"));
      if (add.some((a) => a === "-A" || a === "--all") || args.includes(".")) all = true;
      else paths.push(...args.map((a) => a.replace(/^\.\//, "").replace(/\/$/, "")));
    }
    const commit = gitSub(t, "commit");
    if (commit?.some((a) => a === "-a" || a === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))) {
      trackedAll = true;
    }
  }
  return entries.filter((e) => {
    const staged = e.code[0] !== " " && e.code[0] !== "?";
    if (staged || all) return true;
    if (trackedAll && e.code !== "??") return true;
    return paths.some((p) => e.file === p || e.file.startsWith(`${p}/`));
  });
}

async function commitDetail(cwd: string, segs: string[][]): Promise<string> {
  const raw = await git(cwd, "status", "--porcelain", "--untracked-files=all");
  const entries: StatusEntry[] = raw
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^.* -> /, "") }));
  const files = selectForCommit(entries, segs);
  if (files.length === 0) return "  Files: nothing staged to commit\n";

  // +/- counts are a nicety: a repo without a HEAD yet has none, and that must not cost the list.
  const counts = new Map<string, string>();
  try {
    for (const l of (await git(cwd, "diff", "--numstat", "HEAD")).split("\n")) {
      const [add, del, file] = l.split("\t");
      if (file) counts.set(file, add === "-" ? "binary" : `+${add} -${del}`);
    }
  } catch {
    /* no HEAD */
  }

  const width = Math.min(40, Math.max(...files.map((f) => f.file.length)));
  const lines = files.slice(0, MAX_LISTED).map((f) => {
    const code = f.code === "??" ? "??" : (f.code[0] !== " " ? f.code[0] : f.code[1]);
    const note = SECRET_LIKE.test(f.file) ? "⚠ looks like a secret" : (counts.get(f.file) ?? "");
    return `    ${code.padEnd(2)} ${f.file.padEnd(width)}  ${note}`.trimEnd();
  });
  const more = files.length > MAX_LISTED ? `    … and ${files.length - MAX_LISTED} more\n` : "";
  return `  Files (${files.length}):\n${lines.join("\n")}\n${more}`;
}

async function pushDetail(cwd: string, segs: string[][], commitsFirst: boolean): Promise<string> {
  const branch = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  const push = segs.map((t) => gitSub(t, "push")).find((a) => a) ?? [];
  const explicit = push.filter((a) => !a.startsWith("-"));
  let upstream: string | null = null;
  try {
    upstream = (await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")).trim();
  } catch {
    /* no upstream configured */
  }
  const target = explicit.length > 0 ? explicit.join(" ") : (upstream ?? "no upstream set");
  let count = "";
  if (upstream) {
    try {
      const n = Number((await git(cwd, "rev-list", "--count", `${upstream}..HEAD`)).trim()) +
        (commitsFirst ? 1 : 0);
      count = ` (${n} commit${n === 1 ? "" : "s"})`;
    } catch {
      /* count is optional */
    }
  }
  return `  Push: ${branch} → ${target}${count}\n`;
}

/** Expands rm targets (globs included) to the paths that exist inside the workspace. */
function rmDetail(cwd: string, segs: string[][]): string {
  const targets = segs
    .filter((t) => t[0] === "rm")
    .flatMap((t) => t.slice(1).filter((a) => !a.startsWith("-")))
    .map((a) => a.replace(/^['"]|['"]$/g, ""));
  const globSync = (fs as { globSync?: (p: string, o: { cwd: string }) => string[] }).globSync;
  const found: string[] = [];
  for (const t of targets) {
    const matches = /[*?[]/.test(t) && globSync ? globSync(t, { cwd }) : [t];
    for (const m of matches) {
      const abs = path.resolve(cwd, m);
      if (!abs.startsWith(cwd + path.sep)) continue;
      if (fs.existsSync(abs)) found.push(path.relative(cwd, abs));
    }
  }
  if (found.length === 0) return "  Files: none of the targets exist\n";
  const listed = found.slice(0, MAX_LISTED).map((f) => `    ${f}`).join("\n");
  const more = found.length > MAX_LISTED ? `\n    … and ${found.length - MAX_LISTED} more` : "";
  return `  Files (${found.length}):\n${listed}${more}\n`;
}

/**
 * Lines to insert in the confirm, between the command and "Run it?". Empty when there is nothing
 * to add or when finding out failed — the gate then asks exactly as it did before.
 */
export async function describeCommandImpact(cmd: string, workspacePath: string): Promise<string> {
  const segs = segments(cmd);
  const has = (sub: string) => segs.some((t) => gitSub(t, sub));
  let out = "";
  const parts: Array<() => Promise<string> | string> = [];
  if (has("commit")) parts.push(() => commitDetail(workspacePath, segs));
  if (has("push")) parts.push(() => pushDetail(workspacePath, segs, has("commit")));
  if (segs.some((t) => t[0] === "rm")) parts.push(() => rmDetail(workspacePath, segs));
  for (const part of parts) {
    try {
      out += await part();
    } catch {
      /* this detail is unavailable; the others still help */
    }
  }
  return out;
}
