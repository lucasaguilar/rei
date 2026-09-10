import * as fs from "node:fs";
import {
  FAILED_COMMAND_TAIL_LINES,
  isVerboseOutput,
} from "../../config/output-verbosity.js";
import * as path from "node:path";
import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { executeCommand, limitCommandOutput } from "../../tools/command-executor.js";
import { getAllowedDirs } from "../../tools/sandbox-config.js";
import { getToolOutput } from "./tool-output-store.js";
import { searchWeb } from "../../tools/search-tool.js";
import { getWeather, formatWeatherOutput } from "../../tools/weather-tool.js";
import type { GitChange } from "../../workspace/git-changes.js";
import { detectGitChanges, getGitStatus } from "../../workspace/git-changes.js";
import {
  newElicitationId,
  type ElicitFn,
  type Elicitation,
} from "../../chat/elicitation.js";

/**
 * Built-in NON-edit tool handlers (web_search, weather, run_command, git_changes), extracted from
 * executeAgentTurnWithTools (Phase 2). Each takes the call args + a small context and returns the
 * tool-result string to feed back to the model — no shared loop state is mutated.
 */

interface StatusCtx {
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
}

function formatGitChanges(changes: GitChange[]): string {
  if (changes.length === 0) return "";

  const lines = changes.map((change) => {
    const icon = change.status === "added" ? "A" : change.status === "deleted" ? "D" : "M";
    return `- [${icon}] ${change.filePath}`;
  });

  return `\n### 📁 Uncommitted Changes Detected:\n\n${lines.join("\n")}\n`;
}

/**
 * save_tool_output → writes a retained tool result's FULL content to a file. The bytes are copied
 * by the runtime (from the in-memory store), never routed back through the model, so the saved file
 * is complete even if the model only saw a truncated view. Refuses to write outside the workspace.
 */
export function handleSaveToolOutput(
  args: { path?: unknown; id?: unknown },
  ctx: { workspacePath: string },
): string {
  const dest = String(args.path ?? "").trim();
  if (!dest) return "ERROR: save_tool_output requires a 'path'.";

  const entry = getToolOutput(args.id ? String(args.id) : undefined);
  if (!entry) return "ERROR: no prior tool output available to save.";

  // Resolve against the workspace (relative paths) or honor an absolute path. Allowed if it lands
  // inside the workspace, ~/.rei, or any REI_ALLOWED_DIRS entry — same policy as run_command.
  const abs = path.resolve(ctx.workspacePath, dest);
  const allowed = getAllowedDirs(ctx.workspacePath);
  const isAllowed = allowed.some((d) => abs === d || abs.startsWith(d + path.sep));
  if (!isAllowed) {
    return (
      `ERROR: refusing to write outside allowed directories: ${dest}\n` +
      `Allowed roots: ${allowed.join(", ")}. Add a dir to REI_ALLOWED_DIRS to permit it.`
    );
  }

  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, entry.content, "utf8");
    return `Saved ${entry.content.length} chars from ${entry.tool} → ${dest}`;
  } catch (err) {
    return `ERROR: could not write ${dest}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatGitStatus(files: string[]): string {
  if (files.length === 0) return "";

  const lines = files.map((f) => `- ${f}`);
  return `\n### 📁 Git Status (porcelain):\n\n${lines.join("\n")}\n`;
}

/** web_search → REI's built-in web search, formatted for the model. */
export async function handleWebSearch(
  query: string,
  ctx: StatusCtx & { provider: ModelProvider },
): Promise<string> {
  ctx.logger.logInfo(`[tools] web_search: "${query}"`);
  ctx.emitStatus(`🔍  [REI] Searching the web: ${query}`);
  const results = await searchWeb(query, ctx.provider);
  return `\n### 🔍 Search Results: ${query}\n${results}\n`;
}

/** weather → REI's built-in weather lookup, formatted for the model. */
export async function handleWeather(location: string, ctx: StatusCtx): Promise<string> {
  ctx.logger.logInfo(`[tools] weather: "${location}"`);
  ctx.emitStatus(`🌤️  [REI] Weather: ${location}`);
  const weatherRes = await getWeather(location);
  return `\n### 🌤️ Weather: ${location}\n${formatWeatherOutput(weatherRes)}\n`;
}

/**
 * ask_user → asks the user a clarifying question via the injected ElicitFn and returns their answer
 * as the tool result (fed back to the model). Multiple-choice when `options` are given, free-form
 * otherwise. Headless/non-interactive resolves to the safe default → "did not answer", so the loop
 * never hangs waiting on an absent user. See docs/intent-router-spec.md.
 */
export async function handleAskUser(
  question: string,
  options: string[] | undefined,
  ctx: StatusCtx & { elicit: ElicitFn },
): Promise<string> {
  const q = question.trim();
  if (!q) return "ERROR: ask_user requires a non-empty question.";
  ctx.logger.logInfo(`[tools] ask_user: "${q}"`);
  // NOTE: no emitStatus here — the interactive frontend (CliElicitation) already renders the
  // question in the transcript; a status line would duplicate it. Headless has no user to notify.

  const opts = (options ?? []).filter((o) => typeof o === "string" && o.trim());
  const request: Elicitation =
    opts.length > 0
      ? {
          id: newElicitationId(),
          kind: "select",
          message: q,
          options: opts.map((o) => ({ value: o, label: o })),
          default: opts[0],
        }
      : { id: newElicitationId(), kind: "text", message: q, default: "" };

  const answered = (await ctx.elicit(request)).value.trim();
  return answered
    ? `The user answered: ${answered}`
    : "The user did not answer. Proceed with your best assumption and state it explicitly.";
}

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

/** Returns a human description if the command destroys/discards data, else null. */
export function describeDestructive(cmd: string): string | null {
  for (const p of DESTRUCTIVE_PATTERNS) if (p.test.test(cmd)) return p.describe;
  return null;
}

function confirmDestructiveEnabled(): boolean {
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
  for (const p of GIT_MUTANT_PATTERNS) if (p.test.test(cmd)) return p.describe;
  return null;
}

function confirmGitMutantEnabled(): boolean {
  return process.env.REI_CONFIRM_GIT_MUTANT !== "false"; // default ON
}

/** run_command → execute a shell command in the workspace; returns exit code + (limited) output. */
export async function handleRunCommand(
  cmd: string,
  ctx: StatusCtx & { workspacePath: string; elicit?: ElicitFn },
): Promise<string> {
  ctx.logger.logInfo(`[tools] run_command: ${cmd}`);

  // Confirm destructive commands before running. Only with an interactive frontend (ctx.elicit set):
  // headless/server has no one to ask, and the HARD blocks in command-executor still guard it there.
  const danger = describeDestructive(cmd);
  if (danger && confirmDestructiveEnabled() && ctx.elicit) {
    const { value } = await ctx.elicit({
      id: newElicitationId(),
      kind: "confirm",
      message: `⚠️  This command will ${danger}:\n    ${cmd}\nRun it?`,
      default: "no",
    });
    if (value !== "yes") {
      ctx.emitStatus(`🛑  [REI] Destructive command cancelled by the user: ${cmd}`);
      return (
        `The user DECLINED to run this command (it would ${danger}): ${cmd}\n` +
        `Do NOT run it again. Continue without it, or ask the user how to proceed.`
      );
    }
  }

  // Confirm git commands that MUTATE state (commit/push/merge/rebase/reset/clean/checkout --).
  // Skipped when the destructive gate already fired for this command (e.g. `git reset --hard`),
  // so the user is never asked twice for one command. Same interactive-only guard as above.
  const gitMutant = describeGitMutant(cmd);
  if (!danger && gitMutant && confirmGitMutantEnabled() && ctx.elicit) {
    const { value } = await ctx.elicit({
      id: newElicitationId(),
      kind: "confirm",
      message: `🔀  This command will ${gitMutant}:\n    ${cmd}\nRun it?`,
      default: "no",
    });
    if (value !== "yes") {
      ctx.emitStatus(`🛑  [REI] Git command cancelled by the user: ${cmd}`);
      return (
        `The user DECLINED to run this git command (it would ${gitMutant}): ${cmd}\n` +
        `Do NOT run it again. Continue without it, or ask the user how to proceed.`
      );
    }
  }

  ctx.emitStatus(`💻  [REI] Running: ${cmd}`);
  const cmdResult = await executeCommand(cmd, ctx.workspacePath);
  ctx.logger.logCommandExecution(cmd, cmdResult);
  const stdout = limitCommandOutput(cmdResult.stdout ?? "");
  const stderr = limitCommandOutput(cmdResult.stderr ?? "");

  // Surface the outcome to the USER too (not just the model). A script's result — e.g. a
  // reconciliation report printed to stdout — would otherwise stay invisible unless the model
  // restates it, and if the model runs out of turns the user sees only file patches.
  //
  // Quiet mode shows the exit code and a one-line hint of size; the OUTPUT itself only when the
  // command FAILED, because that is the case that has to be read. Twenty lines per command was the
  // single biggest source of screen noise, and almost all of it was successful output nobody needs.
  const shown = (stdout || stderr).trim();
  const failed = cmdResult.exitCode !== 0;
  if (shown || failed) {
    const lines = shown ? shown.split("\n") : [];
    if (isVerboseOutput()) {
      ctx.emitStatus(`   ↳ exit ${cmdResult.exitCode}\n${lines.slice(-20).join("\n")}`);
    } else if (failed) {
      const tail = lines.slice(-FAILED_COMMAND_TAIL_LINES);
      const elided = lines.length - tail.length;
      ctx.emitStatus(
        `   ↳ exit ${cmdResult.exitCode}` +
          (elided > 0 ? `  (last ${tail.length} of ${lines.length} lines)` : "") +
          (tail.length > 0 ? `\n${tail.join("\n")}` : ""),
      );
    } else {
      ctx.emitStatus(
        `   ↳ exit 0` +
          (lines.length > 0 ? `  (${lines.length} line${lines.length === 1 ? "" : "s"} of output)` : ""),
      );
    }
  }

  return (
    `Exit: ${cmdResult.exitCode}\n` +
      (stdout ? `Stdout:\n${stdout}\n` : "") +
      (stderr ? `Stderr:\n${stderr}\n` : "") || "(no output)"
  );
}

/** git_changes → detect uncommitted changes in the workspace Git repository. */
export async function handleGitChanges(
  ctx: StatusCtx & { workspacePath: string },
): Promise<string> {
  ctx.logger.logInfo(`[tools] git_changes called`);
  ctx.emitStatus("🔍 [REI] Detecting uncommitted changes…");

  const changes = await detectGitChanges(ctx.workspacePath);
  if (changes.length === 0) {
    return `\n### 📁 Git Status: No uncommitted changes\nNothing to commit in this workspace.\n`;
  }

  let output = formatGitChanges(changes);

  // Also check porcelain status for renames, merges in progress, etc.
  const statusFiles = await getGitStatus(ctx.workspacePath);
  if (statusFiles.length > changes.length) {
    const extra = statusFiles.filter((f) => !changes.some((c) => c.filePath === f));
    output += `\n### 📁 Additional Status Entries:\n\n`;
    for (const f of extra) {
      output += `- ${f}\n`;
    }
  }

  return `${output}\n`;
}
