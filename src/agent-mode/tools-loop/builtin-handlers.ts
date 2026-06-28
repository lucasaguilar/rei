import type { AgentLogger } from "../../core/logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import { executeCommand, limitCommandOutput } from "../../tools/command-executor.js";
import { searchWeb } from "../../tools/search-tool.js";
import { getWeather, formatWeatherOutput } from "../../tools/weather-tool.js";

/**
 * Built-in NON-edit tool handlers (web_search, weather, run_command), extracted from
 * executeAgentTurnWithTools (Phase 2). Each takes the call args + a small context and returns the
 * tool-result string to feed back to the model — no shared loop state is mutated.
 */

interface StatusCtx {
  logger: AgentLogger;
  emitStatus: (msg: string) => void;
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
  return (
    `Exit: ${cmdResult.exitCode}\n` +
      (stdout ? `Stdout:\n${stdout}\n` : "") +
      (stderr ? `Stderr:\n${stderr}\n` : "") || "(no output)"
  );
}
