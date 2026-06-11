import type { ToolDefinition } from "../providers/model-provider.js";
import type { McpTool } from "../tools/mcp/mcp-client.js";

// ── Agent capabilities ────────────────────────────────────────────────────────

export const READ_FILES_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "read_files",
    description: "Read the contents of one or more workspace files before editing. Use this when you need to see exact code before proposing changes.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "List of relative workspace file paths to read (max 4 at a time).",
        },
      },
      required: ["paths"],
    },
  },
};

export const EDIT_FILE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Apply a search-and-replace edit to an existing file. The `search` field must contain exact verbatim content from the file (including surrounding context lines to ensure uniqueness). The `replace` field is the new content.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Relative path to the file to edit.",
        },
        search: {
          type: "string",
          description: "Exact verbatim text to find in the file (include 1–2 context lines above and below the change).",
        },
        replace: {
          type: "string",
          description: "Replacement text (the new content for the matched block).",
        },
      },
      required: ["file", "search", "replace"],
    },
  },
};

export const CREATE_FILE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "create_file",
    description: "Create a new file with the provided content. Do NOT use to overwrite an existing file — use edit_file for that.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Relative workspace path for the new file.",
        },
        content: {
          type: "string",
          description: "Complete file content to write.",
        },
      },
      required: ["file", "content"],
    },
  },
};

export const RUN_COMMAND_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "run_command",
    description: "Execute a shell command in the workspace root (e.g. find, grep, npx tsc --noEmit, npm test). Use to explore the codebase, verify types, or run tests.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute.",
        },
      },
      required: ["command"],
    },
  },
};

// ── Utility / external tools ─────────────────────────────────────────────────

export const WEATHER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name or location string.",
        },
      },
      required: ["location"],
    },
  },
};

export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for up-to-date information, prices, news, documentation, or general facts.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
      },
      required: ["query"],
    },
  },
};

// ── Tool sets ────────────────────────────────────────────────────────────────

/** All tools available in agent mode (editing capabilities). */
export const AGENT_TOOLS: ToolDefinition[] = [
  READ_FILES_TOOL,
  EDIT_FILE_TOOL,
  CREATE_FILE_TOOL,
  RUN_COMMAND_TOOL,
];

/** Utility tools available in ask/planning modes. */
export const UTILITY_TOOLS: ToolDefinition[] = [
  WEATHER_TOOL,
  WEB_SEARCH_TOOL,
];

/** All tools combined (agent + utility). */
export const ALL_TOOLS: ToolDefinition[] = [...AGENT_TOOLS, ...UTILITY_TOOLS];

/**
 * Converts MCP tools from the registry into ToolDefinition format for
 * structured function calling via completeChatWithTools.
 *
 * Names are prefixed with "mcp:" (e.g. "mcp:filesystem/readFile") to match
 * the dispatch convention used in the tool handler. The registry returns names
 * as "serverName/toolName" without the prefix, so the dispatch handler must
 * strip "mcp:" before forwarding to McpRegistry.dispatch().
 *
 * McpTool.inputSchema is JSON Schema — structurally identical to
 * ToolParameterSchema — so it maps directly. The fallback handles servers
 * that declare no parameters for a tool.
 */
export function mcpToolsToDefinitions(mcpTools: McpTool[]): ToolDefinition[] {
  return mcpTools.map((tool) => ({
    type: "function" as const,
    // MCP results must be fed back to the model so it can chain calls or act on them.
    modelFeedback: true,
    function: {
      name: `mcp:${tool.name}`,
      description: tool.description,
      parameters: (tool.inputSchema ?? {
        type: "object",
        properties: {},
        required: [],
      }) as ToolDefinition["function"]["parameters"],
    },
  }));
}

/**
 * Returns the set of tool names (as they appear in <call_tool> tags) that
 * require their result to be fed back to the model.
 *
 * Used by the XML-path generators to decide whether to re-invoke the model
 * after a tool call or simply show the result to the user (fire-and-forget).
 * MCP tool names carry the "mcp:" prefix in the definitions but the parser
 * strips nothing — the names in the Set must match what extractToolCalls returns.
 */
export function modelFeedbackToolNames(tools: ToolDefinition[]): Set<string> {
  return new Set(
    tools
      .filter((t) => t.modelFeedback)
      .map((t) => t.function.name),
  );
}

/**
 * Renders the connected MCP tools as a markdown block for the system prompt.
 *
 * Used by the XML-based modes (ask, planning, agent fallback) where tools are
 * NOT passed through the structured `tools` API and must instead be advertised
 * to the model as text so it knows what it can call. Names carry the same
 * "mcp:" prefix as the structured path so the XML dispatcher can recognise and
 * route them (stripping "mcp:" before calling McpRegistry.dispatch).
 *
 * Returns "" when no tools are available so callers can append unconditionally.
 */
export function formatMcpToolsForPrompt(mcpTools: McpTool[]): string {
  if (mcpTools.length === 0) return "";

  const lines = mcpTools.map((tool) => `- mcp:${tool.name} — ${tool.description}`);
  return [
    "## Available MCP Tools",
    'Call these with XML and JSON arguments: `<call_tool name="mcp:server/tool">{ "arg": "value" }</call_tool>`',
    "Emit only the tag (no preamble). You may chain multiple calls — each result is returned before your next step.",
    "",
    "**CRITICAL — execute, don't narrate:** If the user requests an action a tool can perform " +
      "(play/pause/search music, control a device, etc.), you MUST emit the `<call_tool>` to do it. " +
      "NEVER reply with prose describing what you are about to do without actually emitting the tool call " +
      '(e.g. do NOT answer "I will play X on your iPhone:" and stop). If the action needs a parameter you ' +
      "don't have (e.g. a target device id), first call the tool that lists the options, then act on the result.",
    "",
    "**Efficiency — prefer summaries over full content:** Many servers expose a cheap " +
      "`search`/`list` tool that already returns summaries (subject, sender, snippet, title) and a " +
      "separate expensive tool to fetch full content/bodies. To summarize or list items, use the " +
      "`search`/`list` results directly — do NOT fetch the full content of every item. Fetch full " +
      "content ONLY for the specific items the user asks to read in detail. This avoids huge, slow " +
      "responses that can exhaust the context window.",
    "",
    ...lines,
  ].join("\n");
}
