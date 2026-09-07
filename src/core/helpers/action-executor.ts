import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeCommand } from "../../tools/command-executor.js";
import {
  extractCommandRequests,
  extractToolCalls,
} from "../../agent-mode/response-handler.js";
import {
  getWeather,
  formatWeatherOutput,
} from "../../tools/weather-tool.js";
import { searchWeb } from "../../tools/search-tool.js";
import { getGitChanges } from "../../tools/git-changes-tool.js";
import {
  loadSkills,
  skillsForMode,
  findSkill,
  type SkillMode,
} from "../../skills/skill-loader.js";
import { withToolSpan } from "../../telemetry/spans.js";
import type { AgentLogger } from "../logger.js";
import type { ModelProvider } from "../../providers/model-provider.js";
import type { BatchPatchApplyResult } from "../../tools/patch-applier.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";

/**
 * Dispatches a single XML <call_tool> invocation and returns a formatted
 * markdown feedback chunk (with a leading newline). Handles its own errors so
 * callers can simply concatenate the result.
 *
 * Recognises the built-in fire-and-forget tools (weather, search) and any
 * MCP tool addressed as "mcp:server/tool". The "mcp:" prefix mirrors the
 * structured tool-calling path; it is stripped before McpRegistry.dispatch
 * because the registry key is "server/tool".
 */
async function dispatchXmlToolCall(
  call: { name: string; args: Record<string, unknown> },
  provider: ModelProvider,
  logger: AgentLogger,
  mcpRegistry?: McpRegistry,
  workspacePath?: string,
  skillContext?: { workspacePath: string; mode: SkillMode },
): Promise<string> {
  logger.logInfo(`Calling tool: ${call.name}`, { args: call.args });
  try {
    // ── use_skill (meta-tool) ────────────────────────────────────────────
    // Loads a reusable recipe on demand. The catalog lives in the prompt
    // (the use_skill tool's description); here we return the full body so the model can
    // follow it. Scoped to the current mode so planning-only skills aren't
    // loadable from agent and vice-versa.
    if (call.name === "use_skill") {
      if (!skillContext) {
        return `\n[TOOL] use_skill -> ERROR: skills are not available in this context.\n`;
      }
      // XML <call_tool name="use_skill">NAME</call_tool> yields args.input (the
      // tag's inner text); structured/JSON callers may use name/skill instead.
      const skillName = String(
        call.args.input ?? call.args.name ?? call.args.skill ?? "",
      ).trim();
      const skills = skillsForMode(
        loadSkills(skillContext.workspacePath),
        skillContext.mode,
      );
      const skill = findSkill(skills, skillName);
      logger.logInfo(`[tools] use_skill: "${skillName}"`, {
        found: !!skill,
        mode: skillContext.mode,
      });
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        return `\n[TOOL] use_skill("${skillName}") -> ERROR: no such skill for ${skillContext.mode} mode. Available: ${available}\n`;
      }
      return `\n### 🧩 Skill: ${skill.name}\n${skill.body}\n`;
    }
    if (call.name === "weather") {
      return withToolSpan("weather", call.args, async () => {
        const weatherRes = await getWeather(call.args.location as string);
        return `\n### 🌤️ Weather: ${call.args.location}\n${formatWeatherOutput(weatherRes)}\n`;
      });
    }
    if (call.name === "search") {
      return withToolSpan("search", call.args, async () => {
        const searchRes = await searchWeb(call.args.query as string, provider);
        return `\n### 🔍 Search Results: ${call.args.query}\n${searchRes}\n`;
      });
    }
    if (call.name === "git_changes") {
      const wsPath = skillContext?.workspacePath;
      if (!wsPath) {
        return `\n[TOOL] git_changes -> ERROR: workspace path not available.\n`;
      }
      const summary = await getGitChanges(wsPath);
      return `\n### 📁 Git Changes:\n${summary}\n`;
    }
    // Resolve the MCP tool name leniently: the registry key is "server/tool".
    // A "mcp:" prefix routes directly; but models frequently DROP the prefix
    // (e.g. "google_workspace/search_gmail_messages" instead of "mcp:google_workspace/..."),
    // so a bare name is also routed to MCP when it matches a connected tool —
    // otherwise the call wrongly fails as "not implemented".
    if (mcpRegistry) {
      const hasPrefix = call.name.startsWith("mcp:");
      const bareName = hasPrefix ? call.name.slice(4) : call.name;
      let routeToMcp = hasPrefix;
      if (!routeToMcp && typeof mcpRegistry.getAvailableTools === "function") {
        routeToMcp = mcpRegistry
          .getAvailableTools()
          .some((t) => t.name === bareName);
      }

      if (routeToMcp) {
        logger.logInfo(`[tools] mcp: ${bareName}`);
        const result = await mcpRegistry.dispatch(bareName, call.args);

        let formattedResult = result;
        try {
          const parsed = JSON.parse(result);
          formattedResult = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
        } catch {
          formattedResult = `\`\`\`\n${result}\n\`\`\``;
        }
        return `\n### 🔌 MCP: ${bareName}\n${formattedResult}\n`;
      }
    }
    // Tolerant fallback: the model called a skill by its own name instead of via
    // use_skill (e.g. <call_tool name="write-spec">). If the name matches a skill
    // in the current mode, load it — mirrors the lenient MCP bare-name routing.
    // Runs last, so built-in tools and MCP take precedence over a skill name.
    if (skillContext) {
      const skills = skillsForMode(
        loadSkills(skillContext.workspacePath),
        skillContext.mode,
      );
      const skill = findSkill(skills, call.name);
      if (skill) {
        logger.logInfo(`[tools] use_skill (direct name): "${call.name}"`, {
          mode: skillContext.mode,
        });
        return `\n### 🧩 Skill: ${skill.name}\n${skill.body}\n`;
      }
    }
    throw new Error(`Tool "${call.name}" is not implemented.`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `\n[TOOL] ${call.name}(${JSON.stringify(call.args)}) -> ERROR: ${errorMsg}\n`;
  }
}

/**
/**
 * Unifies execution of tools and commands specifically for Agent mode turns.
 */
export async function executeAgentToolsAndCommands(
  response: string,
  workspacePath: string,
  provider: ModelProvider,
  logger: AgentLogger,
  mcpRegistry?: McpRegistry,
): Promise<string> {
  const toolCalls = extractToolCalls(response);
  const commands = extractCommandRequests(response);

  if (toolCalls.length === 0 && commands.length === 0) {
    return "";
  }

  let feedback = "\n\n--- Execution Results ---\n";

  for (const call of toolCalls) {
    feedback += await dispatchXmlToolCall(call, provider, logger, mcpRegistry, workspacePath);
  }

  for (const cmd of commands) {
    logger.logInfo(`Executing command: ${cmd}`);
    const result = await executeCommand(cmd, workspacePath);
    logger.logCommandExecution(cmd, result);
    feedback += `\n[COMMAND] ${cmd} (Exit: ${result.exitCode})\nStdout: ${result.stdout || "none"}\nStderr: ${result.stderr || "none"}\n`;
  }

  return feedback;
}

/**
 * Formats the feedback report from applying a batch of Search-and-Replace edits to the filesystem.
 */
export function formatBatchPatchResult(result: BatchPatchApplyResult): string {
  const header = result.success
    ? `\n\n---\n\u001b[32m\u001b[1m${result.results.length} patch(es) applied directly.\u001b[0m`
    : `\n\n---\n\u001b[31m\u001b[1mSome patches failed to apply.\u001b[0m`;

  const details = result.results
    .map(
      (r) =>
        `\n- ${r.file}: ${r.applied ? "applied" : r.skipped ? "skipped" : "failed"}`,
    )
    .join("");

  return header + details;
}

