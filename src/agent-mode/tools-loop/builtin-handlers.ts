import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { executeCommand, limitCommandOutput } from "../../tools/command-executor.js";
import { searchWeb } from "../../tools/search-tool.js";
import { getWeather, formatWeatherOutput } from "../../tools/weather-tool.js";
import type { GitChange } from "../../workspace/git-changes.js";
import { detectGitChanges, getGitStatus } from "../../workspace/git-changes.js";

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

/** run_command → execute a shell command in the workspace; returns exit code + (limited) output. */
export async function handleRunCommand(
  cmd: string,
  ctx: StatusCtx & { workspacePath: string },
): Promise<string> {
  ctx.logger.logInfo(`[tools] run_command: ${cmd}`);
  ctx.emitStatus(`💻  [REI] Running: ${cmd}`);
  const cmdResult = await executeCommand(cmd, ctx.workspacePath);
  ctx.logger.logCommandExecution(cmd, cmdResult);
  const stdout = limitCommandOutput(cmdResult.stdout ?? "");
  const stderr = limitCommandOutput(cmdResult.stderr ?? "");

  // Surface the output to the USER too (not just the model). Otherwise a script's result — e.g. a
  // reconciliation report a script prints to stdout — stays invisible unless the model restates it,
  // and if the model runs out of turns the user sees only file patches, never the answer. Show a
  // trimmed tail so it's informative without flooding the transcript.
  const shown = (stdout || stderr).trim();
  if (shown) {
    const tail = shown.split("\n").slice(-20).join("\n");
    ctx.emitStatus(`   ↳ exit ${cmdResult.exitCode}\n${tail}`);
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
    return `\n### 📁 Git Status: No uncommitted changes\nNo hay cambios sin confirmar en el workspace.\n`;
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
