import type { ChatMessage } from "../../chat/types.js";
import type { ToolDefinition } from "../../providers/model-provider.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";
import type { AgentLogger } from "../../core/logger.js";
import {
  toolsForMode,
  WEB_SEARCH_TOOL,
  WEATHER_TOOL,
  ASK_USER_TOOL,
  DELEGATE_TOOL,
  mcpToolsToDefinitions,
} from "../../contracts/tool-definitions.js";
import type { SkillMode } from "../../skills/skill-loader.js";
import {
  searchMcpTools,
  SEARCH_TOOLS_DEF,
  MAX_UNFILTERED,
  PRELOAD_K,
} from "../../tools/tool-retriever.js";
import {
  loadSkills,
  buildUseSkillTool,
  skillsForMode,
  type Skill,
} from "../../skills/skill-loader.js";

/** First user message text, scanned from the back. Used to seed tool-search. */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

export interface ToolSelection {
  /** Rebuilds the tool array for the current turn (newly-searched MCP tools become callable). */
  buildTools: () => ToolDefinition[];
  /** MCP tool names currently exposed to the model. MUTABLE — search_tools adds to it. */
  activeMcp: Set<string>;
  /** Every MCP tool the registry offers (the search pool). */
  allMcpTools: ReturnType<McpRegistry["getAvailableTools"]>;
  /** True when many MCP tools are present and tool-search (RAG) mode is active. */
  useToolSearch: boolean;
  /** Agent-scoped skills catalog (the use_skill handler resolves bodies from this). */
  skills: Skill[];
}

/**
 * Sets up tool selection for an agent turn (extracted from executeAgentTurnWithTools — Phase 2).
 *
 * With large MCP servers (e.g. Google Workspace ~60-90 tools) sending every schema overflows
 * local context. When there are many tools, expose only a best-effort pre-load + a `search_tools`
 * meta-tool, letting the model load more on demand (model-driven, no embeddings). Small sets are
 * sent in full. Skills ride as a `use_skill` catalog (name+description only). Returns `buildTools`
 * plus the mutable `activeMcp` set so the loop's search_tools handler can grow it by reference.
 */
export function setupToolSelection(params: {
  mcpRegistry?: McpRegistry;
  messagesForModel: ChatMessage[];
  userQuery?: string;
  workspacePath: string;
  logger: AgentLogger;
  /** Mode whose tool-permission profile gates the built-in tools. Defaults to "agent". */
  mode?: SkillMode;
  /** Expose the `delegate` tool. False inside a sub-agent (depth-1 guard: no nesting). Default true. */
  allowSubAgents?: boolean;
}): ToolSelection {
  const {
    mcpRegistry,
    messagesForModel,
    userQuery,
    workspacePath,
    logger,
    mode = "agent",
    allowSubAgents = true,
  } = params;

  const allMcpTools = mcpRegistry ? mcpRegistry.getAvailableTools() : [];
  const query = userQuery ?? lastUserText(messagesForModel);
  const useToolSearch =
    allMcpTools.length > MAX_UNFILTERED && process.env.REI_TOOL_RAG !== "false";

  // Names of MCP tools currently exposed to the model (grows as it searches).
  const activeMcp = new Set<string>(
    useToolSearch
      ? searchMcpTools(query, allMcpTools, PRELOAD_K).map((t) => t.name)
      : allMcpTools.map((t) => t.name),
  );
  if (useToolSearch) {
    logger.logInfo("[tools] tool-search mode", {
      total: allMcpTools.length,
      preloaded: [...activeMcp],
    });
  }

  // Skills: reusable task recipes loaded on demand. Only the catalog (name + description) rides in
  // the `use_skill` tool; the full body is injected only when the model invokes it. Scoped to the
  // active mode (ask/planning/agent each surface a different skill set).
  const skills = skillsForMode(loadSkills(workspacePath), mode);
  const useSkillTool = buildUseSkillTool(skills);

  // The built-in capability set for this mode (agent → full incl. edits; ask/planning → read-only).
  const baseTools = toolsForMode(mode);

  // The tools array is rebuilt each turn so newly-searched tools become callable.
  const buildTools = (): ToolDefinition[] => {
    const mcp = mcpToolsToDefinitions(allMcpTools.filter((t) => activeMcp.has(t.name)));
    // Expose the built-in web_search + weather tools on the native path too (explicit-trigger
    // only) — otherwise a "search the web" request had no REI tool to call.
    const tools = [...baseTools, WEB_SEARCH_TOOL, WEATHER_TOOL, ASK_USER_TOOL, ...mcp];
    if (allowSubAgents) tools.push(DELEGATE_TOOL);
    if (useToolSearch) tools.push(SEARCH_TOOLS_DEF);
    if (useSkillTool) tools.push(useSkillTool);
    return tools;
  };

  return { buildTools, activeMcp, allMcpTools, useToolSearch, skills };
}
