import { describe, it, expect, vi } from "vitest";
import { setupToolSelection } from "./tool-selection.js";
import type { McpRegistry } from "../../tools/mcp/mcp-registry.js";

const fakeLogger = new Proxy({}, { get: () => vi.fn() }) as never;

const base = {
  messagesForModel: [{ role: "user" as const, content: "hi" }],
  workspacePath: "/tmp/rei-toolsel-test-nonexistent",
  logger: fakeLogger,
};

describe("setupToolSelection", () => {
  it("always includes the built-in agent + web_search + weather tools (no MCP)", () => {
    const sel = setupToolSelection(base);
    const names = sel.buildTools().map((t) => t.function.name);
    expect(names).toContain("read_files");
    expect(names).toContain("edit_file");
    expect(names).toContain("web_search");
    expect(names).toContain("weather");
    expect(sel.useToolSearch).toBe(false);
    expect(sel.allMcpTools).toEqual([]);
  });

  it("exposes a small MCP tool set in full (no search_tools meta-tool)", () => {
    const mcpRegistry = {
      getAvailableTools: () => [
        { name: "mcp_a", description: "a", inputSchema: { type: "object" } },
        { name: "mcp_b", description: "b", inputSchema: { type: "object" } },
      ],
    } as unknown as McpRegistry;
    const sel = setupToolSelection({ ...base, mcpRegistry });
    const names = sel.buildTools().map((t) => t.function.name);
    // MCP tools are namespaced with an `mcp:` prefix in the definitions.
    expect(names).toContain("mcp:mcp_a");
    expect(names).toContain("mcp:mcp_b");
    expect(names).not.toContain("search_tools");
    expect(sel.useToolSearch).toBe(false);
  });

  it("buildTools reflects newly-activated MCP tools (activeMcp is mutable by reference)", () => {
    const mcpRegistry = {
      getAvailableTools: () => [
        { name: "mcp_a", description: "a", inputSchema: { type: "object" } },
      ],
    } as unknown as McpRegistry;
    const sel = setupToolSelection({ ...base, mcpRegistry });
    // Simulate the search_tools handler growing/shrinking the active set (by reference).
    sel.activeMcp.delete("mcp_a");
    expect(sel.buildTools().map((t) => t.function.name)).not.toContain("mcp:mcp_a");
    sel.activeMcp.add("mcp_a");
    expect(sel.buildTools().map((t) => t.function.name)).toContain("mcp:mcp_a");
  });
});
