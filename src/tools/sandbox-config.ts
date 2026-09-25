import * as os from "node:os";
import * as path from "node:path";

/**
 * Static allow-list of commands the REI sandbox permits by default. Commands not in
 * this set are rejected unless explicitly added via REI_ALLOWED_COMMANDS.
 */
export const STATIC_ALLOWED_COMMANDS = new Set([
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
  // `env` is deliberately absent: its entire output is the process environment, which is where the
  // API keys live. Values are masked (see secret-masking.ts), but the variable NAMES alone describe
  // the machine's whole configuration, and no build step needs them. `env FOO=bar cmd` goes away
  // with it — write the assignment into the command's own invocation instead.
  "curl", "git", "which", "date", "printf", "echo", "chmod", "command",
  "rm", "tar", "unzip", "file", "wget",
  "true", "false", "test",
  // Read-only text utilities (file exploration: read by parts, slice, count)
  "head", "tail", "sed", "awk", "wc", "sort", "uniq", "cut", "tr",
  // Read-only exploration/search (no writes, no sub-command execution): faster/cleaner
  // ways for the agent to search, compare and inspect the tree than the ones above.
  "rg", "egrep", "fgrep", "diff", "jq", "stat", "basename", "dirname", "realpath",
  // macOS automation
  "osascript",
  // REI internal
  "rtk",
]);

/**
 * Commands that are always denied regardless of allow-list. Checked before the allow-list
 * so a user can't bypass the sandbox by adding these to REI_ALLOWED_COMMANDS.
 */
export const DENIED_KEYWORDS: readonly string[] = [
  "rm -rf",
  "sudo",
  "chown",
  "mkfs",
];

/**
 * Returns the full list of allowed commands: the static set plus any extra entries
 * from the REI_ALLOWED_COMMANDS environment variable (comma-separated). Validates each
 * entry is a safe identifier — only letters, digits, dashes and underscores — so accidental
 * values like paths or wildcards can't bypass the sandbox.
 */
export function getAllowedCommands(): string[] {
  const base = [...STATIC_ALLOWED_COMMANDS];
  const raw = process.env.REI_ALLOWED_COMMANDS ?? "";
  if (!raw.trim()) return base;
  const safe = /^[A-Za-z0-9_-]+$/;
  const extras = raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => safe.test(c))
    .filter((c) => !STATIC_ALLOWED_COMMANDS.has(c)); // deduplicate
  return [...base, ...extras];
}

/**
 * Returns extra directories allowed by the REI sandbox, read from the REI_ALLOWED_DIRS
 * environment variable (comma-separated). Expands `~` to the user's home directory and
 * normalizes each path.
 */
export function getExtraAllowedDirs(): string[] {
  const raw = process.env.REI_ALLOWED_DIRS ?? "";
  if (!raw.trim()) return [];
  const homedir = os.homedir();
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.normalize(p.startsWith("~") ? path.join(homedir, p.slice(1)) : p));
}

/**
 * Returns the full list of allowed directories: workspace root + ~/.rei + any extra
 * entries from REI_ALLOWED_DIRS. Used by resolveCdTarget, writeRedirectFile, and the rm guard.
 */
export function getAllowedDirs(workspaceRoot: string): string[] {
  return [
    path.normalize(workspaceRoot),
    path.normalize(path.join(os.homedir(), ".rei")),
    ...getExtraAllowedDirs(),
  ];
}
