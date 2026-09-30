/**
 * The deterministic confirm gates on run_command, split out of builtin-handlers.ts: which commands
 * get a confirm, and the one-line description of what they do. What the command will TOUCH (files,
 * push target) is command-impact.ts.
 */

// Deterministic safety gate: commands that DELETE or DISCARD data get an explicit user confirm
// before running (the model may issue them without realising the cost). This complements the HARD
// blocks already in command-executor (rm -rf and out-of-workspace rm are rejected outright) by
// catching the permitted-but-destructive cases (a single-file rm, git reset --hard) that would
// otherwise run silently. See docs/intent-router-spec.md — "deterministic gates".
//
// Every pattern is paired with a false-positive case in command-gates.test.ts: a gate that fires on
// routine work (`2>&1`, `>> log`, `git stash pop`) gets switched off, and then protects nothing.
const DESTRUCTIVE_PATTERNS: Array<{ test: RegExp; describe: string }> = [
  // The lookbehind leaves `docker rm` / `docker volume rm` to the docker entry: they delete
  // containers, not files, and the prompt should say which.
  {
    test: /(^|[\s;&|])(?<!(docker|podman)(\s+(container|volume|image|network|compose))?\s)rm\s+/,
    describe: "delete file(s)",
  },
  { test: /(^|[\s;&|])find\s.*\s-delete\b/, describe: "delete the files find matches (find -delete)" },
  // `>` truncates its target before the command even runs. Only a bare `>` (or `1>`) after
  // whitespace counts: `2>&1`, `>&2`, `>>`, `=>`, `->` and the throwaway /dev/null and /tmp/ do not.
  {
    test: /(^|[\s;&|(])1?>(?![>&|])\s*(?!\/dev\/null\b|\/tmp\/)[^\s&|;]/,
    describe: "overwrite a file (> redirection)",
  },
  { test: /(^|[\s;&|])truncate\s+/, describe: "truncate (empty) a file" },
  { test: /(^|[\s;&|])dd\s.*\bof=/, describe: "overwrite a file or device (dd of=)" },
  { test: /(^|[\s;&|])shred\s+/, describe: "overwrite and delete file(s) (shred)" },
  { test: /git\s+reset\s+--hard/, describe: "discard ALL uncommitted changes (git reset --hard)" },
  { test: /git\s+clean\s+-[a-z]*f/, describe: "delete untracked files (git clean)" },
  { test: /git\s+checkout\s+(--|\.(\s|$)|-f\b|--force\b)/, describe: "discard local changes (git checkout)" },
  { test: /git\s+switch\b[^;&|]*(--discard-changes|\s-f\b|--force\b)/, describe: "discard local changes (git switch)" },
  // `git restore <path>` resets the working tree; `--staged` alone only unstages.
  {
    test: /git\s+restore\b(?![^;&|]*--staged)|git\s+restore\b[^;&|]*(--worktree|\s-W\b)/,
    describe: "discard local changes (git restore)",
  },
  {
    test: /git\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/,
    describe: "overwrite the remote's history (force push)",
  },
  { test: /git\s+branch\s+(-[a-zA-Z]*D\b|--delete\s+--force\b)/, describe: "delete a branch even if unmerged (git branch -D)" },
  { test: /git\s+stash\s+(drop|clear)\b/, describe: "discard stashed work (git stash drop/clear)" },
  {
    test: /(^|[\s;&|])(npm|pnpm|bun|yarn(\s+npm)?|cargo)\s+publish\b(?![^;&|]*--dry-run)/,
    describe: "publish a package to the registry (irreversible)",
  },
  {
    test: /(^|[\s;&|])(docker|podman)\s+(((container|volume|image|network)\s+)?(rm|rmi|prune)\b|system\s+prune\b)|(docker|podman)[\s-]compose\s+(down\b[^;&|]*(\s-v\b|--volumes\b|--rmi\b)|rm\b)/,
    describe: "delete docker containers / volumes / images",
  },
  { test: /(^|[\s;&|])kubectl\s+delete\b/, describe: "delete kubernetes resources (kubectl delete)" },
  // Only through a SQL client: `grep -rn 'DELETE FROM' src` is a search, not a delete.
  {
    test: /(^|[\s;&|])(psql|mysql|mariadb|sqlite3|sqlcmd|duckdb|clickhouse-client)\b.*\b(drop\s+(table|database|schema|view|index)\b|truncate\s+(table\s+)?\w|delete\s+from\b)/is,
    describe: "run destructive SQL (DROP / TRUNCATE / DELETE)",
  },
];

/**
 * Every matching description, joined. First-match-wins hid the rest of a chain: for
 * `git add -A && git commit && git push` the user was told "create a commit" and never "push".
 */
function describeAll(cmd: string, patterns: Array<{ test: RegExp; describe: string }>): string | null {
  const hits = [...new Set(patterns.filter((p) => p.test.test(cmd)).map((p) => p.describe))];
  return hits.length > 0 ? hits.join(" + ") : null;
}

/** Returns a human description if the command destroys/discards data, else null. */
export function describeDestructive(cmd: string): string | null {
  return describeAll(cmd, DESTRUCTIVE_PATTERNS);
}

export function confirmDestructiveEnabled(): boolean {
  return process.env.REI_CONFIRM_DESTRUCTIVE !== "false"; // default ON
}

// Deterministic safety gate for git commands that MUTATE state (commit, push, merge, rebase,
// reset, clean, checkout --). Unlike the destructive gate above (which fires for data LOSS),
// these are additive/rewriting but still change the repo or the remote, so they get their own
// explicit confirm. Read-only git (status/diff/log/show) never prompts. `git reset --hard`,
// `git clean -f` and `git checkout --` are ALSO destructive — the stronger destructive gate
// catches them first, so this one is skipped for them (no double prompt). See
// docs/intent-router-spec.md — "deterministic gates".
const GIT_MUTANT_PATTERNS: Array<{ test: RegExp; describe: string }> = [
  { test: /(^|[\s;&|])git\s+commit\b/, describe: "create a commit" },
  { test: /(^|[\s;&|])git\s+push\b/, describe: "push to the remote (affects others)" },
  { test: /(^|[\s;&|])git\s+merge\b/, describe: "merge branches" },
  { test: /(^|[\s;&|])git\s+rebase\b/, describe: "rewrite history via rebase" },
  { test: /(^|[\s;&|])git\s+reset\b/, describe: "move the branch pointer (git reset)" },
  { test: /(^|[\s;&|])git\s+clean\b/, describe: "delete untracked files (git clean)" },
  { test: /(^|[\s;&|])git\s+checkout\s+(--|\.(?:\s|$))/, describe: "discard local changes (git checkout)" },
];

/** Returns a human description if the command mutates git state, else null. */
export function describeGitMutant(cmd: string): string | null {
  return describeAll(cmd, GIT_MUTANT_PATTERNS);
}

export function confirmGitMutantEnabled(): boolean {
  return process.env.REI_CONFIRM_GIT_MUTANT !== "false"; // default ON
}

