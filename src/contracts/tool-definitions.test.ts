import { describe, it, expect } from "vitest";
import { mcpToolsToDefinitions, modelFeedbackToolNames, WEATHER_TOOL, WEB_SEARCH_TOOL } from "./tool-definitions.js";
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

