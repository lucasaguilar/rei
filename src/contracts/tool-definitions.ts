import type { ToolDefinition } from "../providers/model-provider.js";

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
