import type { ToolDefinition } from "../providers/model-provider.js";
import type { McpTool } from "../tools/mcp/mcp-client.js";

// ── Agent capabilities ────────────────────────────────────────────────────────

export const READ_FILES_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "read_files",
    description:
      "Read one or more workspace files before editing. Large files are returned in pages: if the " +
      "result ends with '[N more lines — continue with offset=...]', call read_files again with that " +
      "offset to read the next page. This guarantees you receive the WHOLE file (in pieces), never a " +
      "silently truncated view. Prefer this over shell (cat/head), whose output is capped.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "List of relative workspace file paths to read (max 4 at a time).",
        },
        offset: {
          type: "integer",
          description: "1-based start line for paging a large file (default 1). Use the value from a previous page's continue hint.",
        },
        limit: {
          type: "integer",
          description: "Max lines to return this call (default from REI_READ_MAX_LINES). Omit to use the default page size.",
        },
      },
      required: ["paths"],
    },
  },
};

export const GREP_CODE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "grep_code",
    description:
      "Search the repository for a regex pattern (ripgrep). Returns bounded `file:line: text` matches " +
      "plus a total count — the fast way to LOCATE code in a large repo without reading whole files. " +
      "Prefer this over shell grep (whose output gets capped mid-result). Scope with 'path'/'glob'.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for (e.g. \"class SmartForm\" or \"function\\\\s+load\")." },
        path: { type: "string", description: "Optional subdirectory or file to limit the search to (relative to workspace)." },
        glob: { type: "string", description: "Optional file glob, e.g. \"*.ts\" or \"src/**/*.tsx\"." },
        max_results: { type: "integer", description: "Max matches to return (default 50)." },
      },
      required: ["pattern"],
    },
  },
};

export const LIST_FILES_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "list_files",
    description:
      "List workspace files matching a glob (ripgrep --files). The fast way to DISCOVER files by name " +
      "in a large repo (e.g. all \"*.component.ts\"). Bounded output with a total count.",
    parameters: {
      type: "object",
      properties: {
        glob: { type: "string", description: "File glob, e.g. \"**/*.service.ts\" or \"*.md\". Omit to list everything (bounded)." },
        path: { type: "string", description: "Optional subdirectory to limit to (relative to workspace)." },
        max_results: { type: "integer", description: "Max paths to return (default 200)." },
      },
      required: [],
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

export const ASK_USER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the user a clarifying question when a decision is genuinely theirs, or the request is " +
      "ambiguous — and ask BEFORE doing work that might be wrong. Do NOT use it for anything you " +
      "can determine yourself by reading the repo or running a command. Provide `options` for a " +
      "multiple-choice question, or omit them for a free-form answer. " +
      'Example: ask_user({question: "Is this a login or a signup form?", options: ["login", "signup"]}).',
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional choices for the user to pick from (omit for a free-form answer).",
        },
      },
      required: ["question"],
    },
  },
};

export const DELEGATE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "delegate",
    description:
      "Delegate a SELF-CONTAINED subtask to a fresh sub-agent that runs in an ISOLATED, clean " +
      "context — it does NOT see this conversation. Use it for a well-specified piece of work you " +
      "have already thought through, to keep YOUR context lean. Provide a COMPLETE task description " +
      "and the relevant file paths (the sub-agent starts fresh, so include everything it needs). It " +
      "returns a short summary; its file edits land on disk. Do NOT delegate vague or exploratory " +
      'work. Example: delegate({task: "add a `pruned` flag to ChatMessage and filter it in ' +
      'buildMessagesForModel", files: ["src/chat/types.ts", "src/chat/message-builder.ts"]}).',
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The complete, self-contained task for the sub-agent.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Workspace file paths the sub-agent should read/edit.",
        },
      },
      required: ["task"],
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

export const SAVE_TOOL_OUTPUT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "save_tool_output",
    description:
      "Write the FULL content of a previous tool's output to a file on disk WITHOUT routing the bytes " +
      "through you. Use this to persist large fetched content (e.g. a Jira/Confluence document) that " +
      "would otherwise be truncated — the runtime copies the retained bytes straight to the file, so " +
      "the saved file is always complete. Call it right after the tool that produced the output.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Destination file path, relative to the workspace (e.g. "task.md" or "docs/JIRA-123.md").',
        },
        id: {
          type: "string",
          description:
            "Optional id of the output to save (shown in the tool-output receipt). Defaults to the most recent tool output.",
        },
      },
      required: ["path"],
    },
  },
};

// ── Tool sets ────────────────────────────────────────────────────────────────

/** All tools available in agent mode (editing capabilities). */
export const AGENT_TOOLS: ToolDefinition[] = [
  READ_FILES_TOOL,
  GREP_CODE_TOOL,
  LIST_FILES_TOOL,
  EDIT_FILE_TOOL,
  CREATE_FILE_TOOL,
  REWRITE_FILE_TOOL,
  RUN_COMMAND_TOOL,
  GIT_CHANGES_TOOL,
  SAVE_TOOL_OUTPUT_TOOL,
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
  GREP_CODE_TOOL,
  LIST_FILES_TOOL,
  RUN_COMMAND_TOOL,
  GIT_CHANGES_TOOL,
  SAVE_TOOL_OUTPUT_TOOL,
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


