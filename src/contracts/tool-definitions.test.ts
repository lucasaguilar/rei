import { describe, it, expect } from "vitest";
import { mcpToolsToDefinitions, formatMcpToolsForPrompt, modelFeedbackToolNames, WEATHER_TOOL, WEB_SEARCH_TOOL } from "./tool-definitions.js";
import type { McpTool } from "../tools/mcp/mcp-client.js";

const TOOLS: McpTool[] = [
  {
    name: "filesystem/readFile",
    description: "Read a file's contents",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "filesystem/listDir",
    description: "List a directory",
    // no inputSchema → fallback
  },
];

describe("mcpToolsToDefinitions", () => {
  it("prefixes names with 'mcp:' and passes the inputSchema through", () => {
    const defs = mcpToolsToDefinitions([TOOLS[0]]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("mcp:filesystem/readFile");
    expect(defs[0].function.description).toBe("Read a file's contents");
    expect(defs[0].function.parameters).toEqual(TOOLS[0].inputSchema);
  });

  it("falls back to an empty object schema when inputSchema is missing", () => {
    const defs = mcpToolsToDefinitions([TOOLS[1]]);
    expect(defs[0].function.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
  });

  it("returns an empty array for no tools", () => {
    expect(mcpToolsToDefinitions([])).toEqual([]);
  });
});

describe("mcpToolsToDefinitions modelFeedback flag", () => {
  it("sets modelFeedback: true on every MCP tool definition", () => {
    const defs = mcpToolsToDefinitions(TOOLS);
    expect(defs.every((d) => d.modelFeedback === true)).toBe(true);
  });
});

describe("modelFeedbackToolNames", () => {
  it("returns the set of mcp: names that need model re-feed", () => {
    const mcpDefs = mcpToolsToDefinitions(TOOLS);
    const names = modelFeedbackToolNames([...mcpDefs, WEATHER_TOOL, WEB_SEARCH_TOOL]);
    expect(names.has("mcp:filesystem/readFile")).toBe(true);
    expect(names.has("mcp:filesystem/listDir")).toBe(true);
    expect(names.has("weather")).toBe(false);
    expect(names.has("web_search")).toBe(false);
  });

  it("returns an empty set when no tools have modelFeedback", () => {
    expect(modelFeedbackToolNames([WEATHER_TOOL, WEB_SEARCH_TOOL]).size).toBe(0);
  });
});

describe("formatMcpToolsForPrompt", () => {
  it("returns '' when there are no tools", () => {
    expect(formatMcpToolsForPrompt([])).toBe("");
  });

  it("lists each tool as 'mcp:name — description'", () => {
    const block = formatMcpToolsForPrompt(TOOLS);
    expect(block).toContain("## Available MCP Tools");
    expect(block).toContain("- mcp:filesystem/readFile — Read a file's contents");
    expect(block).toContain("- mcp:filesystem/listDir — List a directory");
    // Teaches the XML JSON-argument convention
    expect(block).toContain('<call_tool name="mcp:server/tool">');
  });
});
