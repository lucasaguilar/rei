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
const DESTRUCTIVE_PATTERNS: Array<{ test: RegExp; describe: string }> = [
  { test: /(^|[\s;&|])rm\s+/, describe: "delete file(s)" },
  { test: /git\s+reset\s+--hard/, describe: "discard ALL uncommitted changes (git reset --hard)" },
  { test: /git\s+clean\s+-[a-z]*f/, describe: "delete untracked files (git clean)" },
  { test: /git\s+checkout\s+(--|\.(\s|$))/, describe: "discard local changes (git checkout)" },
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

