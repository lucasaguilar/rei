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

export const REWRITE_FILE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "rewrite_file",
    description:
      "Overwrite an existing file with its COMPLETE new content. Use ONLY when " +
      "edit_file repeatedly fails to match the search block — this avoids the exact " +
      "search-match requirement entirely. Provide the full corrected file content.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Relative path to the file to overwrite.",
        },
        content: {
          type: "string",
          description: "The COMPLETE new content of the file (replaces it entirely).",
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

export const GIT_CHANGES_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "git_changes",
    description: "Detect uncommitted changes in the workspace Git repository (added, modified, deleted files). Useful for understanding what has been changed before editing.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// ── Tool sets ────────────────────────────────────────────────────────────────

/** All tools available in agent mode (editing capabilities). */
export const AGENT_TOOLS: ToolDefinition[] = [
  READ_FILES_TOOL,
  EDIT_FILE_TOOL,
  CREATE_FILE_TOOL,
  REWRITE_FILE_TOOL,
  RUN_COMMAND_TOOL,
  GIT_CHANGES_TOOL,
];

/** Utility tools available in ask/planning modes. */
export const UTILITY_TOOLS: ToolDefinition[] = [
  WEATHER_TOOL,
  WEB_SEARCH_TOOL,
];

/**
 * Read-only tool set for the ask/planning modes on the native function-calling path.
 * Mirrors what those modes could already do via the XML interception path
 * (`executeAndFormatTurnActions` handled file reads, commands and MCP/web calls — never
 * edit/create/rewrite), so routing them through the native loop preserves their permissions:
 * investigate (read_files / git_changes), run read-style commands (grep/rg/git/build), but NOT
 * mutate files directly. `run_command` is intentionally included — it matches the XML path's
 * `<execute_command>` capability.
 */
export const READONLY_TOOLS: ToolDefinition[] = [
  READ_FILES_TOOL,
  RUN_COMMAND_TOOL,
  GIT_CHANGES_TOOL,
];

/**
 * The base built-in tool set a mode is allowed to use. The native loop layers web_search/weather,
 * MCP and skills on top of this; this only governs the file/command capabilities. agent → full
 * (can edit); ask/planning → read-only (investigate + run commands, no direct file mutation).
 */
export function toolsForMode(mode: "agent" | "planning" | "ask"): ToolDefinition[] {
  return mode === "agent" ? AGENT_TOOLS : READONLY_TOOLS;
}

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

