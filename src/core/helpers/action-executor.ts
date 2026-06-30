import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeCommand, limitCommandOutput } from "../../tools/command-executor.js";
import {
  extractCommandRequests,
  extractToolCalls,
  extractFileRequests,
} from "../../agent-mode/response-handler.js";
import {
  getWeather,
  formatWeatherOutput,
} from "../../tools/weather-tool.js";
import { searchWeb } from "../../tools/search-tool.js";
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
  skillContext?: { workspacePath: string; mode: SkillMode },
): Promise<string> {
  logger.logInfo(`Calling tool: ${call.name}`, { args: call.args });
  try {
    // ── use_skill (meta-tool) ────────────────────────────────────────────
    // Loads a reusable recipe on demand. The catalog lives in the prompt
    // (buildSkillCatalogText); here we return the full body so the model can
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
 * Reads the contents of any <request_files> tags found in a response and returns formatted feedback.
 * When files are not found, appends a strong hint telling the model to use
 * <execute_command> (ls/grep) to discover the real paths.
 */
export async function executeFileRequestsFromResponse(
  response: string,
  workspacePath: string,
  logger: AgentLogger,
): Promise<string> {
  const fileRequests = extractFileRequests(response);
  if (fileRequests.length === 0) return "";

  let feedback = "\n\n---\n**Requested Files Context:**\n";
  let foundCount = 0;
  let notFoundCount = 0;

  for (const f of fileRequests) {
    logger.logInfo(`Non-agent requested file: ${f}`);
    const absPath = path.join(workspacePath, f);
    try {
      const content = await fs.readFile(absPath, "utf-8");
      feedback += `\n### File: ${f}\n\`\`\`\n${content}\n\`\`\`\n`;
      foundCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      feedback += `\n### File: ${f}\n(Could not read file: ${errorMsg})\n`;
      notFoundCount++;
    }
  }

  // If some (or all) files were not found, tell the model to use
  // <execute_command> to discover the real paths instead of guessing.
  if (notFoundCount > 0) {
    feedback += `\n⚠️  [REI] ${notFoundCount} of ${fileRequests.length} requested file(s) could not be read — they likely do not exist at the specified paths. ` +
      `Use <execute_command>ls</execute_command>, <execute_command>find . -name "PATTERN"</execute_command>, or <execute_command>grep -r "PATTERN" src/</execute_command> to discover the real file paths in the workspace.\n`;
  }

  return feedback;
}

/**
 * Executes any <execute_command> tags found in a response and returns formatted feedback.
 */
export async function executeCommandsFromResponse(
  response: string,
  workspacePath: string,
  logger: AgentLogger,
): Promise<string> {
  const commands = extractCommandRequests(response);
  if (commands.length === 0) return "";

  let feedback = "\n\n---\n**Command Results:**\n```\n";
  for (const cmd of commands) {
    logger.logInfo(`Executing command: ${cmd}`);
    const result = await executeCommand(cmd, workspacePath);
    logger.logCommandExecution(cmd, result);
    const output = limitCommandOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    );
    feedback += `$ ${cmd}\n${output || "(no output)"} [exit: ${result.exitCode}]\n\n`;
  }
  feedback += "```";
  return feedback;
}

/**
 * Executes any <call_tool> tags found in a response and returns formatted feedback.
 */
export async function executeToolCallsFromResponse(
  response: string,
  provider: ModelProvider,
  logger: AgentLogger,
  mcpRegistry?: McpRegistry,
  skillContext?: { workspacePath: string; mode: SkillMode },
): Promise<string> {
  const toolCalls = extractToolCalls(response);
  if (toolCalls.length === 0) return "";

  let feedback = "\n\n---\n**Tool Call Results:**\n";
  for (const call of toolCalls) {
    feedback += await dispatchXmlToolCall(
      call,
      provider,
      logger,
      mcpRegistry,
      skillContext,
    );
  }
  return feedback;
}

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
    feedback += await dispatchXmlToolCall(call, provider, logger, mcpRegistry);
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

/**
 * Executes and formats the turn actions (<request_files>, <execute_command>, <call_tool>) for streaming responses.
 */
export async function executeAndFormatTurnActions(params: {
  response: string;
  workspacePath: string;
  provider: ModelProvider;
  logger: AgentLogger;
  mcpRegistry?: McpRegistry;
  mode?: SkillMode;
}): Promise<{ executionFeedback: string; userVisibleFeedback: string }> {
  const { response, workspacePath, provider, logger, mcpRegistry, mode } =
    params;
  const fileRequests = extractFileRequests(response);
  const commands = extractCommandRequests(response);
  const toolCalls = extractToolCalls(response);

  let executionFeedback = "";
  let userVisibleFeedback = "";

  if (fileRequests.length > 0) {
    const fileFeedback = await executeFileRequestsFromResponse(
      response,
      workspacePath,
      logger,
    );
    executionFeedback += fileFeedback;

    // Count found vs not-found from the feedback to report accurately.
    // The feedback contains "(Could not read file:" for each missing file.
    const notFound = (fileFeedback.match(/\(Could not read file:/g) || [])
      .length;
    const found = fileRequests.length - notFound;

    if (found > 0 && notFound > 0) {
      userVisibleFeedback +=
        `\n📂 **[REI] ${found} of ${fileRequests.length} requested file(s) found in context:**\n` +
        fileRequests.map((f) => `- \`${f}\``).join("\n") +
        (notFound > 0
          ? `\n⚠️  ${notFound} file(s) not found — use <execute_command>ls</execute_command>, <execute_command>find . -name "PATTERN"</execute_command>, or <execute_command>grep -r "PATTERN" src/</execute_command> to discover real paths.`
          : "") +
        "\n";
    } else if (found === fileRequests.length) {
      userVisibleFeedback +=
        `\n📂 **[REI] Injected ${fileRequests.length} requested file(s) into context:**\n` +
        fileRequests.map((f) => `- \`${f}\``).join("\n") +
        "\n";
    } else {
      // All files not found — report clearly.
      userVisibleFeedback +=
        `\n📂 **[REI] 0 of ${fileRequests.length} requested file(s) found.** ` +
        `None of the specified paths exist. Use <execute_command>ls</execute_command> or <execute_command>find/grep</execute_command> to discover the real paths.\n` +
        fileRequests.map((f) => `- \`${f}\``).join("\n") +
        "\n";
    }
  }

  if (commands.length > 0) {
    const cmdFeedback = await executeCommandsFromResponse(
      response,
      workspacePath,
      logger,
    );
    executionFeedback += cmdFeedback;
    userVisibleFeedback += cmdFeedback;
  }

  if (toolCalls.length > 0) {
    const toolFeedback = await executeToolCallsFromResponse(
      response,
      provider,
      logger,
      mcpRegistry,
      mode ? { workspacePath, mode } : undefined,
    );
    executionFeedback += toolFeedback;
    userVisibleFeedback += toolFeedback;
  }

  return { executionFeedback, userVisibleFeedback };
}
