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

  it("ask/planning modes get a READ-ONLY built-in set (no edit/create/rewrite)", () => {
    for (const mode of ["ask", "planning"] as const) {
      const names = setupToolSelection({ ...base, mode })
        .buildTools()
        .map((t) => t.function.name);
      // Investigation + commands stay available...
      expect(names).toContain("read_files");
      expect(names).toContain("run_command");
      expect(names).toContain("git_changes");
      expect(names).toContain("web_search");
      expect(names).toContain("weather");
      // ...but the mutating tools are gated out.
      expect(names).not.toContain("edit_file");
      expect(names).not.toContain("create_file");
      expect(names).not.toContain("rewrite_file");
    }
  });

  it("defaults to the agent profile (edits allowed) when no mode is passed", () => {
    const names = setupToolSelection(base)
      .buildTools()
      .map((t) => t.function.name);
    expect(names).toContain("edit_file");
    // Explicit mode: "agent" matches the default.
    const agentNames = setupToolSelection({ ...base, mode: "agent" })
      .buildTools()
      .map((t) => t.function.name);
    expect(agentNames).toContain("edit_file");
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
